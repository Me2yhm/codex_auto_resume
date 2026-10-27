import { createHash } from "crypto";
import type { CodexTurn } from "./types";
import { answeredQuestionFollowedByWork } from "./answeredQuestionRecovery";

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
  /** Structural only: never serialize question text, options or answers. */
  questionSignals?: QuestionSignal[];
}
export interface QuestionSignal {
  itemIndex: number;
  itemType: string;
  itemStatus: "completed" | "inProgress" | "failed" | "declined" | "interrupted" | "other" | null;
  questionCount: number;
  explicitlyResolved: number;
  explicitlyPending: number;
  unknown: number;
  laterProgressItems: number;
  pendingTool: boolean;
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
// Automatic context compaction is a known Codex lifecycle event, neither a
// new user instruction nor positive evidence that the user request executed.
// Unknown item kinds must continue to fail closed.
const NEUTRAL_CONTEXT = new Set(["contextCompaction"]);
function knownHistoryItem(item: unknown): boolean {
  return record(item) &&
    (item.type === "userMessage" || PROGRESS.has(String(item.type)) ||
      NEUTRAL_CONTEXT.has(String(item.type)));
}

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

/** Lifecycle progress is conclusive only with unambiguous input handling.
 * A fully answered and acknowledged structured question is not new steering. */
export function hasUnambiguousInputProgress(turn: CodexTurn): boolean {
  if (!hasRecordedProgress(turn) || !Array.isArray(turn.items)) return false;
  if (answeredQuestionFollowedByWork(turn)) return true;
  const users = turn.items.filter(item => record(item) && item.type === "userMessage");
  return users.length === 1 && turn.items[0] === users[0] && !waitingOnQuestion(turn.items) &&
    turn.items.every(knownHistoryItem);
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
    // Merely mentioning a managed Codex path is NOT evidence that the user
    // pasted a file. Official IDE context also includes paths to open tabs,
    // and an ordinary request can quote such paths without attaching them.
    // Only an explicit but unrecognized attachment-metadata shape is unsafe
    // to flatten. Never load a path discovered outside a recognized block.
    const managedPath = /[\\/]\.codex[\\/]attachments[\\/]/i;
    const looksLikeAttachmentMetadata =
      managedPath.test(text) &&
      (
        /^\s*#{1,3}\s*(?:files?\s+(?:pasted|attached|uploaded)\s+by\s+(?:the\s+)?user|(?:pasted|attached|uploaded)\s+(?:files?|text|attachments?)|attachments?)\b/im.test(text) ||
        text.split(/\r?\n/).some(line =>
          managedPath.test(line) && (
            /^\s*#{2,3}\s+"(?:\\.|[^"\\])*"\s*:\s*/.test(line) ||
            /^\s*(?:[-*]\s*)?(?:pasted\s+(?:attachment|file|text)|attached\s+file|uploaded\s+file)\s*:/i.test(line)
          ))
      );
    return looksLikeAttachmentMetadata
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
  // Some IDE payloads contain the standard heading with no pasted files.
  // If the section is genuinely empty and closes normally at My request,
  // it has nothing to dereference. Any malformed/nonempty line was rejected
  // above, so this cannot discard actual attachment metadata.
  if (closed && references.length === 0) return { present: false, references: [], labels: [] };
  if (!closed || references.length > 4 ||
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

/**
 * A second quota-failed turn can be the result of an earlier automatic replay.
 * If the newest turn has substantively executed the exact same user input,
 * prior *user-only* quota rejections of that identical input are not extra
 * independent instructions. No persistence of the replay lineage is required:
 * a reload or a missed UI receipt may have cleared it before re-exhaustion.
 *
 * Reject any changed input, additional user message, older work, unknown
 * item, or unhandled question; such cases must remain needs_review.
 */
function repeatedQuotaInputWithExecution(pending: CodexTurn[]): boolean {
  if (pending.length < 2) return false;
  const newest = pending[0];
  if (!hasUnambiguousInputProgress(newest) || !Array.isArray(newest.items)) return false;
  const first = newest.items[0];
  if (!record(first) || first.type !== "userMessage" || !Array.isArray(first.content)) return false;
  const expectedContent = canonical(first.content);
  return pending.slice(1).every(turn => {
    if (!isQuotaFailure(turn) || turn.itemsView !== "full" ||
        !Array.isArray(turn.items) || turn.items.length !== 1) return false;
    const item = turn.items[0];
    return record(item) && item.type === "userMessage" &&
      Array.isArray(item.content) && canonical(item.content) === expectedContent;
  });
}

const QUESTION_TOOLS = new Set([
  "request_user_input", "request_user_input_async", "request_permissions", "request_approval",
]);
type QuestionState = "resolved" | "pending" | "unknown";

/** A completed agentMessage does NOT prove its embedded question was answered.
 * Only explicit per-question resolution metadata can release this guard.
 * Codex request/resolved events can also clear a pending prompt when a turn
 * is interrupted, but that notification is not guaranteed in turn history. */
function questionState(question: unknown): QuestionState {
  if (!record(question)) return "unknown";
  const positive = question.answered === true || question.resolved === true ||
    question.isAnswered === true ||
    question.status === "answered" || question.status === "resolved";
  const negative = question.answered === false || question.resolved === false ||
    question.isAnswered === false ||
    ["pending", "inProgress", "unanswered", "waiting"].includes(String(question.status));
  // Conflicting metadata is ambiguous, never permission to continue.
  if (positive && negative) return "unknown";
  if (negative) return "pending";
  if (positive) return "resolved";
  return "unknown";
}

/** Metadata-only question audit for Inspect. No prompt, answer, option,
 * arbitrary status or tool arguments may leave the local full-history reader. */
export function questionSignals(items: unknown[]): QuestionSignal[] {
  const signals: QuestionSignal[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!record(item)) continue;
    const questions = Array.isArray(item.questions) ? item.questions : [];
    const pendingTool = item.type === "dynamicToolCall" &&
      QUESTION_TOOLS.has(String(item.tool)) && item.status !== "completed";
    if (!questions.length && !pendingTool) continue;
    const states = questions.map(questionState);
    const knownStatuses = ["completed", "inProgress", "failed", "declined", "interrupted"];
    const status = typeof item.status === "string"
      ? (knownStatuses.includes(item.status) ? item.status : "other") : null;
    signals.push({
      itemIndex: index,
      itemType: String(item.type),
      itemStatus: status as QuestionSignal["itemStatus"],
      questionCount: questions.length,
      explicitlyResolved: states.filter(state => state === "resolved").length,
      explicitlyPending: states.filter(state => state === "pending").length,
      unknown: states.filter(state => state === "unknown").length,
      laterProgressItems: items.slice(index + 1).filter(itemHasProgress).length,
      pendingTool,
    });
    if (signals.length >= 16) break;
  }
  return signals;
}

/** Explicit user confirmation may release an AMBIGUOUS historical question
 * after verified work; it may NOT override a known pending question/permission,
 * unknown activity, second user input or unstarted task. This never grants
 * execution permissions and never chooses to replay attachments. */
export function canManuallyConfirmQuestionContinuation(turn: CodexTurn): boolean {
  if (!isQuotaFailure(turn) || turn.itemsView !== "full" ||
      !Array.isArray(turn.items) || !hasRecordedProgress(turn)) return false;
  const items = turn.items;
  const users = items.filter(item => record(item) && item.type === "userMessage");
  if (users.length !== 1 || items[0] !== users[0] ||
      !items.every(knownHistoryItem)) return false;
  // Only the diagnostic display is capped at 16 question groups. Safety
  // decisions must scan the entire turn, including later permission requests.
  const signals = questionSignals(items);
  if (!signals.some(signal => signal.unknown > 0)) return false;
  for (const item of items) {
    if (!record(item)) continue;
    if (item.type === "dynamicToolCall" &&
        QUESTION_TOOLS.has(String(item.tool)) && item.status !== "completed") return false;
    if (Array.isArray(item.questions) &&
        item.questions.some(question => questionState(question) === "pending")) return false;
  }
  return true;
}

function waitingOnQuestion(items: unknown[]): boolean {
  // Do not treat an explicitly resolved historical question as a current
  // pending request. Ambiguous metadata and actual pending tools still block.
  return items.some(item => {
    if (!record(item)) return false;
    if (Array.isArray(item.questions) &&
        item.questions.some(question => questionState(question) !== "resolved")) return true;
    return item.type === "dynamicToolCall" &&
      QUESTION_TOOLS.has(String(item.tool)) && item.status !== "completed";
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
    const interactions = questionSignals(turn.items);
    if (interactions.length) evidence.questionSignals = interactions;
    plan.evidence.push(evidence);
  }
  if (totalBytes > MAX_INPUT_BYTES) return { ...plan, inputs: [], reason: "input_too_large" };
  if (invalid) return { ...plan, reason: "items_not_full_or_malformed" };
  if (!isQuotaFailure(latest)) return { ...plan, reason: "latest_turn_not_quota_failed" };
  if (plan.inputs.length === 0) return { ...plan, reason: "input_not_found" };
  const items = latest.items!;
  // An accepted input replay can hit quota a second time after real work.
  // Earlier quota-only turns with the IDENTICAL input are historical attempts,
  // not multiple unresolved instructions. Changed/independent inputs stay
  // blocked, even when the newest turn has recorded work.
  if (repeatedQuotaInputWithExecution(pending)) {
    return { ...plan, action: "continue", candidate: "continue",
      reason: "replayed_input_followed_by_execution" };
  }
  // Multiple user messages in one turn can be a completed interactive
  // question/answer, not independent quota-rejected tasks. Require a
  // structured reply and explicit post-answer agent work. Never infer this
  // from an unrelated tool that completed before the answer.
  if (pending.length === 1 && answeredQuestionFollowedByWork(latest)) {
    return { ...plan, action: "continue", candidate: "continue",
      reason: "answered_question_followed_by_execution" };
  }
  if (plan.inputs.length !== 1) return { ...plan, reason: "multiple_unresolved_inputs" };
  if (waitingOnQuestion(items)) {
    if (unchanged && previous?.approval?.action === "continue" &&
        previous.approval.fingerprint === fingerprint &&
        canManuallyConfirmQuestionContinuation(latest)) {
      return { ...plan, action: "continue", candidate: "continue",
        reason: "user_confirmed_ambiguous_question_continue",
        approval: previous.approval };
    }
    return { ...plan, reason: "unanswered_question_or_approval" };
  }
  if (items.some(item => !knownHistoryItem(item))) {
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
