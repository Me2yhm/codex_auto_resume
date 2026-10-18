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

/** Snapshot of text that the official IDE persisted only as a TXT path. */
export interface PastedTxtSnapshot {
  /** Display label serialized by the official pasted-TXT prompt helper. */
  label: string;
  sourcePath: string;
  sha256: string;
  byteLength: number;
  text: string;
}
export interface PastedTxtUiAttachment {
  label: string;
  path: string;
  fsPath: string;
  isPastedText: true;
}
export interface AttachmentIntegrity {
  status: "verified" | "unverified" | "missing" | "modified" | "unsafe_reference" |
    "unsupported_encoding" | "too_large" | "invalid_reference";
  count: number;
  bytes: number;
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
  pastedTxtSnapshots?: PastedTxtSnapshot[];
  attachmentIntegrity?: AttachmentIntegrity;
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

/** Obtain the original plain text, before any pasted-file expansion. */
export function originalReplayText(plan: Pick<RecoveryPlan, "inputs">): string | undefined {
  if (plan.inputs.length !== 1) return undefined;
  const content = plan.inputs[0].content;
  if (content.length !== 1 || !record(content[0])) return undefined;
  const part = content[0];
  if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim() ||
      !Array.isArray(part.text_elements) || part.text_elements.length !== 0 ||
      Object.keys(part).some(key => !["type", "text", "text_elements"].includes(key)) ||
      Buffer.byteLength(part.text, "utf8") > MAX_INPUT_BYTES) return undefined;
  return part.text;
}

export type PastedTxtReferences = { present: false; references: []; labels: [] } |
  { present: true; references: string[]; labels: string[]; error?: "invalid_reference" };

/** Recognize only the official "Files pasted by the user" metadata block.
 * The label is JSON-quoted in the installed Codex serializer; do not infer
 * labels from filenames or arbitrary paths outside this block. */
export function pastedTxtReferences(text: string): PastedTxtReferences {
  const header = /^# Files pasted by the user:\s*$/gmi;
  const headers = [...text.matchAll(header)];
  if (headers.length === 0) {
    return /[\\/]\.codex[\\/]attachments[\\/]/i.test(text)
      ? { present: true, references: [], labels: [], error: "invalid_reference" }
      : { present: false, references: [], labels: [] };
  }
  if (headers.length !== 1 || text.includes("[Codex Auto Resume: verified contents of pasted TXT attachment ")) {
    return { present: true, references: [], labels: [], error: "invalid_reference" };
  }
  const block = text.slice(headers[0].index! + headers[0][0].length).split(/\r?\n/);
  const references: string[] = [];
  const labels: string[] = [];
  let closed = false;
  for (const line of block) {
    if (/^## My request:\s*$/i.test(line)) { closed = true; break; }
    if (!line.trim()) continue;
    const matched = /^##\s+("(?:\\.|[^"\\])*"):\s+(.+?)\s*$/.exec(line);
    if (!matched || !/\.txt$/i.test(matched[2])) {
      return { present: true, references: [], labels: [], error: "invalid_reference" };
    }
    let label: unknown;
    try { label = JSON.parse(matched[1]); } catch {
      return { present: true, references: [], labels: [], error: "invalid_reference" };
    }
    if (typeof label !== "string" || !label.trim()) {
      return { present: true, references: [], labels: [], error: "invalid_reference" };
    }
    references.push(matched[2]);
    labels.push(label);
  }
  if (!closed || references.length === 0 || references.length > 4 ||
      new Set(references).size !== references.length) {
    return { present: true, references: [], labels: [], error: "invalid_reference" };
  }
  return { present: true, references, labels };
}

function verifiedPastedTxtSnapshots(
  plan: Pick<RecoveryPlan, "pastedTxtSnapshots" | "attachmentIntegrity">,
  original: string,
  refs: Extract<PastedTxtReferences, { present: true }>,
): PastedTxtSnapshot[] | undefined {
  if (refs.error || plan.attachmentIntegrity?.status !== "verified" ||
      !plan.pastedTxtSnapshots || plan.pastedTxtSnapshots.length !== refs.references.length) return undefined;
  const snapshots = plan.pastedTxtSnapshots;
  let totalBytes = Buffer.byteLength(original, "utf8");
  for (let index = 0; index < refs.references.length; index += 1) {
    const snapshot = snapshots[index];
    const raw = Buffer.from(snapshot.text, "utf8");
    if (snapshot.sourcePath !== refs.references[index] || snapshot.label !== refs.labels[index] ||
        raw.length !== snapshot.byteLength ||
        createHash("sha256").update(raw).digest("hex") !== snapshot.sha256) return undefined;
    totalBytes += snapshot.byteLength;
  }
  return totalBytes <= MAX_INPUT_BYTES ? snapshots : undefined;
}

/** The request body remains the exact original serialized input. TXT is sent
 * separately as official UI context.attachments, never appended to the body. */
export function replayText(plan: Pick<RecoveryPlan, "inputs" | "pastedTxtSnapshots" | "attachmentIntegrity">): string | undefined {
  const original = originalReplayText(plan);
  if (original === undefined) return undefined;
  const refs = pastedTxtReferences(original);
  if (!refs.present) return original;
  return verifiedPastedTxtSnapshots(plan, original, refs) ? original : undefined;
}

/** Reconstruct the UI-only attachment metadata observed in openai.chatgpt
 * 26.1007.21434. This is an internal, version-gated IPC contract, not an
 * App Server turn/start field. Paths refer to existing official managed files. */
export function replayAttachments(
  plan: Pick<RecoveryPlan, "inputs" | "pastedTxtSnapshots" | "attachmentIntegrity">,
): PastedTxtUiAttachment[] | undefined {
  const original = originalReplayText(plan);
  if (original === undefined) return undefined;
  const refs = pastedTxtReferences(original);
  if (!refs.present) return [];
  const snapshots = verifiedPastedTxtSnapshots(plan, original, refs);
  if (!snapshots) return undefined;
  return snapshots.map(snapshot => ({
    label: snapshot.label,
    path: snapshot.sourcePath,
    fsPath: snapshot.sourcePath,
    isPastedText: true,
  }));
}

/** Input equality alone is not delivery proof; used only after this controller
 * already recorded an accepted dispatch, to avoid assigning its lineage to a
 * different newer user message. */
export function matchesReplayedInput(turn: CodexTurn, plan: RecoveryPlan): boolean {
  if (turn.itemsView !== "full" || !Array.isArray(turn.items)) return false;
  const users = turn.items.filter(item => record(item) && item.type === "userMessage");
  if (users.length !== 1 || !record(users[0]) || plan.inputs.length !== 1) return false;
  const originalMatch = canonical(users[0].content) === canonical(plan.inputs[0].content);
  if (!originalMatch) return false;
  const original = originalReplayText(plan) ?? "";
  const refs = pastedTxtReferences(original);
  if (!refs.present) return true;
  const expected = replayAttachments(plan);
  if (!expected) return false;
  // The durable accepted-dispatch claim proves our sender passed this context.
  // Some App Server history versions omit UI-only attachment metadata; if it
  // is present, it must match the exact pinned manifest.
  if (users[0].attachments === undefined || users[0].attachments === null) return true;
  if (!Array.isArray(users[0].attachments)) return false;
  const actual = users[0].attachments.map(value => {
    if (!record(value)) return null;
    return { label: value.label, path: value.path, fsPath: value.fsPath, isPastedText: value.isPastedText };
  });
  return canonical(actual) === canonical(expected);
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
  if (originalReplayText(plan) === undefined) return { ...plan, reason: "unsupported_structured_input" };
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
    attachmentSha256: plan.pastedTxtSnapshots?.map(snapshot => snapshot.sha256) ?? [],
    attachmentIntegrity: plan.attachmentIntegrity ?? { status: pastedTxtReferences(originalReplayText(plan) ?? "").present
      ? "unverified" : "not_applicable", count: 0, bytes: 0 },
    // Attachment contents and absolute source paths are deliberately not logged.
    warning: "User-only full history does not independently prove that execution never began." };
}
