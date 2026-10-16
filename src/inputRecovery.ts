import { createHash } from "crypto";
import type { CodexTurn } from "./types";

export type RecoveryAction = "continue" | "replay_input" | "needs_review";
export type UserOnlyPolicy = "review" | "replayStableUserOnly";
export const INPUT_STABILITY_MS = 10_000;
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_AUTOMATIC_REPLAYS = 2;

export interface SavedRecoveryInput {
  turnId: string;
  messageId: string;
  content: unknown[];
}
export interface RecoveryEvidence {
  turnId: string;
  status: string;
  itemsView: string;
  itemTypes: string[];
  messageIds: string[];
  inputBytes: number;
}
export interface RecoveryHistory {
  turns: CodexTurn[]; // newest first; ends at a prior execution/non-quota boundary
  complete: boolean;
  reason?: string;
}
export interface RecoveryPlan {
  version: 1;
  sourceTurnId: string;
  fingerprint: string;
  action: RecoveryAction;
  candidate?: "continue" | "replay_input";
  reason: string;
  inputs: SavedRecoveryInput[]; // oldest first, never silently retain only the last
  evidence: RecoveryEvidence[];
  stableSinceMs: number;
  observedAtMs: number;
  approval?: { action: "continue" | "replay_input"; fingerprint: string };
  stale?: boolean;
}

const PROGRESS = new Set([
  "agentMessage", "reasoning", "plan", "commandExecution", "fileChange",
  "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity",
  "webSearch", "imageView", "imageGeneration",
]);

export function isQuotaFailure(turn: CodexTurn): boolean {
  return (turn.status === "failed" || turn.status === "interrupted") &&
    (turn.error?.codexErrorInfo === "usageLimitExceeded" || turn.error?.codexErrorInfo === "rateLimitExceeded");
}
export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function hasRecordedProgress(turn: CodexTurn): boolean {
  return turn.itemsView === "full" && Array.isArray(turn.items) &&
    turn.items.some(itemHasProgress);
}

/** Empty lifecycle placeholders are not evidence that user input was handled. */
function itemHasProgress(item: unknown): boolean {
  if (!record(item) || !PROGRESS.has(String(item.type))) return false;
  const nonempty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  if (item.type === "agentMessage" || item.type === "plan") return nonempty(item.text);
  if (item.type === "reasoning") {
    return [item.summary, item.content].some(value => Array.isArray(value) && value.some(nonempty));
  }
  // A recorded tool operation may have side effects even without visible output.
  return ["inProgress", "completed", "failed"].includes(String(item.status)) ||
    nonempty(item.command) || nonempty(item.tool) || nonempty(item.path) ||
    (Array.isArray(item.changes) && item.changes.length > 0);
}

/** Lifecycle progress is only conclusive for one unambiguous input, not steering. */
export function hasUnambiguousInputProgress(turn: CodexTurn): boolean {
  if (!hasRecordedProgress(turn) || !Array.isArray(turn.items)) return false;
  const users = turn.items.filter(item => record(item) && item.type === "userMessage");
  return users.length === 1 && turn.items[0] === users[0] && !waitingOnQuestion(turn.items) &&
    turn.items.every(item => record(item) && (item.type === "userMessage" || PROGRESS.has(String(item.type))));
}

/** Stable ordering prevents an object-key reorder being mistaken for an edit. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function recoveryFingerprint(history: RecoveryHistory): string {
  return createHash("sha256").update(canonical(history)).digest("hex");
}

/** Only the exact payload the existing text IPC wrapper can reproduce is eligible. */
export function replayText(plan: Pick<RecoveryPlan, "inputs">): string | undefined {
  if (plan.inputs.length !== 1) return undefined;
  const content = plan.inputs[0].content;
  if (content.length !== 1 || !record(content[0])) return undefined;
  const part = content[0];
  if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim() ||
      !Array.isArray(part.text_elements) || part.text_elements.length !== 0 ||
      Object.keys(part).some(key => !["type", "text", "text_elements"].includes(key)) ||
      Buffer.byteLength(part.text, "utf8") > MAX_INPUT_BYTES) return undefined;
  return part.text; // Do not trim, summarize, translate or append a generic continuation.
}

/** Input equality alone is not delivery proof; used only after this controller
 * already recorded an accepted dispatch, to avoid assigning its lineage to a
 * different newer user message. Unknown payloads never receive that lineage. */
export function matchesReplayedInput(turn: CodexTurn, plan: RecoveryPlan): boolean {
  if (turn.itemsView !== "full" || !Array.isArray(turn.items)) return false;
  const users = turn.items.filter(item => record(item) && item.type === "userMessage");
  return users.length === 1 && record(users[0]) && plan.inputs.length === 1 &&
    canonical(users[0].content) === canonical(plan.inputs[0].content);
}

function waitingOnQuestion(items: unknown[]): boolean {
  return items.some(item => {
    if (!record(item)) return false;
    if (Array.isArray(item.questions) && item.questions.length > 0) return true;
    return item.type === "dynamicToolCall" &&
      ["request_user_input", "request_permissions", "request_approval"].includes(String(item.tool)) &&
      item.status !== "completed";
  });
}

/**
 * Full user-only history is a candidate, not proof of pre-execution rejection.
 * The default policy requires a per-source human decision. Opt-in automatic
 * replay is deliberately named after the evidence it actually has.
 */
export function classifyRecoveryHistory(
  history: RecoveryHistory,
  options: { nowMs: number; previous?: RecoveryPlan; policy?: UserOnlyPolicy; replayAttempts?: number; replaySourceTurnId?: string },
): RecoveryPlan {
  const { nowMs, previous } = options;
  const fingerprint = recoveryFingerprint(history);
  const unchanged = previous?.fingerprint === fingerprint && !previous.stale;
  const plan: RecoveryPlan = {
    version: 1, sourceTurnId: history.turns[0]?.id ?? previous?.sourceTurnId ?? "",
    fingerprint, action: "needs_review", reason: "history_incomplete", inputs: [], evidence: [],
    stableSinceMs: unchanged ? previous.stableSinceMs : nowMs, observedAtMs: nowMs,
  };
  if (!history.complete || !history.turns.length) {
    return { ...plan, reason: history.reason ?? "history_incomplete",
      inputs: previous?.inputs ?? [], evidence: previous?.evidence ?? [], stale: true };
  }
  const latest = history.turns[0];
  const pending: CodexTurn[] = [];
  for (const turn of history.turns) {
    if (pending.length && (turn.id === options.replaySourceTurnId || !isQuotaFailure(turn) || hasRecordedProgress(turn))) break;
    pending.push(turn);
  }
  let invalid = false;
  let totalBytes = 0;
  for (const turn of pending.slice().reverse()) {
    if (turn.itemsView !== "full" || !Array.isArray(turn.items)) { invalid = true; continue; }
    const evidence: RecoveryEvidence = { turnId: turn.id, status: turn.status, itemsView: turn.itemsView,
      itemTypes: [], messageIds: [], inputBytes: 0 };
    for (const item of turn.items) {
      if (!record(item) || typeof item.type !== "string") { invalid = true; continue; }
      evidence.itemTypes.push(item.type);
      if (item.type !== "userMessage") continue;
      if (typeof item.id !== "string" || !item.id || !Array.isArray(item.content)) { invalid = true; continue; }
      const bytes = Buffer.byteLength(JSON.stringify(item.content), "utf8");
      totalBytes += bytes;
      evidence.inputBytes += bytes;
      evidence.messageIds.push(item.id);
      if (totalBytes <= MAX_INPUT_BYTES) {
        plan.inputs.push({ turnId: turn.id, messageId: item.id, content: JSON.parse(JSON.stringify(item.content)) });
      }
    }
    plan.evidence.push(evidence);
  }
  if (totalBytes > MAX_INPUT_BYTES) return { ...plan, inputs: [], reason: "input_too_large" };
  if (invalid) return { ...plan, reason: "items_not_full_or_malformed" };
  if (!isQuotaFailure(latest)) return { ...plan, reason: "latest_turn_not_quota_failed" };
  if (plan.inputs.length === 0) return { ...plan, reason: "input_not_found" };
  if (plan.inputs.length !== 1) return { ...plan, reason: "multiple_unresolved_inputs" };
  const items = latest.items!;
  if (waitingOnQuestion(items)) return { ...plan, reason: "unanswered_question_or_approval" };
  if (items.some(item => !record(item) || (item.type !== "userMessage" && !PROGRESS.has(String(item.type))))) {
    return { ...plan, reason: "unknown_item_or_context_activity" };
  }
  const userIndex = items.findIndex(item => record(item) && item.type === "userMessage");
  if (userIndex !== 0) return { ...plan, reason: "ambiguous_steering_order" };
  if (hasRecordedProgress(latest)) {
    return { ...plan, candidate: "continue", action: "continue", reason: "recorded_execution_after_input" };
  }
  if (items.length !== 1) return { ...plan, reason: "incomplete_activity_evidence" };
  if (replayText(plan) === undefined) return { ...plan, reason: "unsupported_structured_input" };
  plan.candidate = "replay_input";
  plan.reason = "user_only_history_requires_review";
  if (unchanged && previous?.approval?.fingerprint === fingerprint) {
    return { ...plan, action: previous.approval.action, approval: previous.approval, reason: "user_confirmed_action" };
  }
  if ((options.replayAttempts ?? 0) >= MAX_AUTOMATIC_REPLAYS) return { ...plan, reason: "automatic_replay_limit" };
  if (options.policy === "replayStableUserOnly") {
    if (nowMs - plan.stableSinceMs < INPUT_STABILITY_MS) return { ...plan, reason: "waiting_for_stable_full_history" };
    return { ...plan, action: "replay_input", reason: "opt_in_stable_user_only_history" };
  }
  return plan;
}

/** Redacted structural report: never include input text, tool output or credentials. */
export function recoveryDiagnostic(plan: RecoveryPlan): Record<string, unknown> {
  return { schemaVersion: 1, action: plan.action, candidate: plan.candidate ?? null,
    reason: plan.reason, sourceTurnId: plan.sourceTurnId, fingerprint: plan.fingerprint,
    observedAtMs: plan.observedAtMs, stableSinceMs: plan.stableSinceMs, stale: Boolean(plan.stale),
    replayableText: replayText(plan) !== undefined, evidence: plan.evidence,
    warning: "User-only full history does not independently prove that execution never began." };
}
