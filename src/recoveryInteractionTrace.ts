import { createHash } from "crypto";
import type { CodexTurn, ThreadTurnsListResponse } from "./types";
import { questionSignals } from "./inputRecovery";

type RpcReader = {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
};

type RecordValue = Record<string, unknown>;
type IdToken = { field: string; digest: string };
const MAX_PAGES = 5;
const PAGE_SIZE = 10;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_QUESTION_ITEMS = 16;
const MAX_FIELDS = 24;
const IDS = new Set(["id", "requestId", "request_id", "callId", "call_id",
  "toolCallId", "tool_call_id", "questionItemId", "serverRequestId"]);
const STATE_KEYS = new Set(["status", "state", "answered", "resolved", "isAnswered",
  "isResolved", "pending", "completed"]);
const KNOWN_STATES = new Set(["pending", "waiting", "inProgress", "completed",
  "failed", "cancelled", "canceled", "declined", "interrupted", "answered",
  "resolved", "unanswered", "accepted", "rejected"]);
const KNOWN_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning", "plan",
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView",
  "imageGeneration", "contextCompaction"]);
const fieldOK = /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/;
const obj = (v: unknown): v is RecordValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function digest(v: string): string {
  return "sha256:" + createHash("sha256").update(v).digest("hex").slice(0, 24);
}
function redactedField(k: string): string {
  // Arbitrary JSON object keys may contain private data. Common schema keys
  // are useful, but non-schema keys are represented by a one-way digest.
  return fieldOK.test(k) && k.length <= 48 &&
    !/(password|secret|token|cookie|private|credential|apiKey)/i.test(k)
    ? k : "field_" + digest(k);
}
function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}
function shape(v: unknown): Array<{ field: string; type: string }> {
  if (!obj(v)) return [];
  return Object.keys(v).sort().slice(0, MAX_FIELDS).map(k => ({
    field: redactedField(k), type: kind(v[k]),
  }));
}
function safeType(v: unknown): string {
  return typeof v === "string" && KNOWN_ITEM_TYPES.has(v) ? v : "unrecognized_item";
}
function safeState(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && KNOWN_STATES.has(v) ? v : "other";
}
function states(value: unknown): Array<{ field: string; value: boolean | string | null }> {
  if (!obj(value)) return [];
  return Object.keys(value).filter(k => STATE_KEYS.has(k)).sort().map(k => {
    const v = value[k];
    return { field: k, value: typeof v === "boolean" ? v : safeState(v) };
  });
}
function idTokens(value: unknown, prefix = ""): IdToken[] {
  if (!obj(value)) return [];
  const result: IdToken[] = [];
  for (const k of Object.keys(value)) {
    if (!IDS.has(k)) continue;
    const raw = value[k];
    if (typeof raw !== "string" || !raw || raw.length > 1024) continue;
    result.push({ field: prefix + k, digest: digest(raw) });
    if (k === "questionItemId") {
      // Codex can encode ["request_user_input_async", "call_x", 0] inside
      // questionItemId. Only emit its CALL ID digest, never its source value.
      try {
        const tuple: unknown = JSON.parse(raw);
        if (Array.isArray(tuple) && tuple.length === 3 &&
            (tuple[0] === "request_user_input_async" || tuple[0] === "request_user_input") &&
            typeof tuple[1] === "string" && tuple[1].length <= 1024) {
          result.push({ field: prefix + k + ".call", digest: digest(tuple[1]) });
        }
      } catch { /* opaque IDs are valid; no need to log their bytes */ }
    }
  }
  return result.slice(0, 16);
}
function relatedIds(item: unknown): IdToken[] {
  if (!obj(item)) return [];
  const tokens = idTokens(item);
  for (const k of ["request", "response", "result", "metadata"]) {
    if (obj(item[k])) tokens.push(...idTokens(item[k], k + "."));
  }
  return tokens.slice(0, 24);
}
function replyIds(item: unknown): IdToken[] {
  if (!obj(item) || item.type !== "userMessage" || !Array.isArray(item.content)) return [];
  const result: IdToken[] = [];
  for (const part of item.content.slice(0, 2)) {
    if (!obj(part) || part.type !== "text" || typeof part.text !== "string") continue;
    const raw = part.text.trim();
    const open = "<send_user_message_question_reply>";
    const close = "</send_user_message_question_reply>";
    if (!raw.startsWith(open) || !raw.endsWith(close) || raw.length > 64 * 1024) continue;
    try {
      const values: unknown = JSON.parse(raw.slice(open.length, -close.length));
      if (!Array.isArray(values)) continue;
      for (const answer of values.slice(0, 8)) {
        if (!obj(answer) || typeof answer.questionItemId !== "string") continue;
        result.push(...idTokens(answer));
      }
    } catch { /* malformed reply is only a structural observation */ }
  }
  return result.slice(0, 16);
}
function itemMeta(items: unknown[], i: number) {
  const item = items[i];
  return {
    itemIndex: i,
    itemType: obj(item) ? safeType(item.type) : "unrecognized_item",
    itemStatus: obj(item) ? safeState(item.status) : null,
    hasQuestions: obj(item) && Array.isArray(item.questions) && item.questions.length > 0,
    hasReplyEnvelope: replyIds(item).length > 0,
  };
}

/** Pure, bounded, source-content-free report. Does not classify/approve work. */
export function buildInteractionTrace(turn: CodexTurn) {
  const items = turn.itemsView === "full" && Array.isArray(turn.items) ? turn.items : [];
  const detected = questionSignals(items);
  const totalQuestionItems = items.filter(item => obj(item) &&
    ((Array.isArray(item.questions) && item.questions.length > 0) ||
      (item.type === "dynamicToolCall" &&
        ["request_user_input", "request_user_input_async", "request_permissions",
          "request_approval"].includes(String(item.tool)) &&
        item.status !== "completed"))).length;
  const questionIndexes = detected.slice(0, MAX_QUESTION_ITEMS).map(s => s.itemIndex);
  const questionDetails = questionIndexes.map(index => {
    const item = items[index];
    const signal = detected.find(x => x.itemIndex === index);
    const questions = obj(item) && Array.isArray(item.questions) ? item.questions : [];
    const details = questions.slice(0, 8).map((q, qIndex) => ({
      questionIndex: qIndex,
      fields: shape(q),
      stateFields: states(q),
      ids: idTokens(q),
      nestedFields: obj(q) ? ["request", "metadata", "resolution", "response"]
        .filter(k => obj(q[k])).map(k => ({ field: k, fields: shape(q[k]) })) : [],
    }));
    const related = new Set<string>();
    for (const q of details) for (const id of q.ids) related.add(id.digest);
    const matchingRecords: Array<{ itemIndex: number; itemType: string;
      matchingDigests: string[]; evidenceType: string }> = [];
    for (let i = 0; i < items.length; i += 1) {
      if (i === index) continue;
      const matches = [...relatedIds(items[i]), ...replyIds(items[i])]
        .map(token => token.digest).filter(h => related.has(h));
      if (matches.length) matchingRecords.push({
        itemIndex: i, itemType: itemMeta(items, i).itemType,
        matchingDigests: [...new Set(matches)].slice(0, 8),
        evidenceType: "identifier_match_only_not_resolution_proof",
      });
      if (matchingRecords.length >= 16) break;
    }
    const neighbors = Array.from({ length: Math.min(items.length, 7) }, (_, i) => i);
    // Only the immediate neighborhood; do not show full turn content.
    const lo = Math.max(0, index - 3);
    const hi = Math.min(items.length, index + 4);
    const neighborhood = neighbors.slice(0, hi - lo).map((_, offset) => itemMeta(items, lo + offset));
    return {
      ...signal,
      parentFields: shape(item),
      parentStateFields: states(item),
      questionDetails: details,
      neighborhood,
      matchingRecords,
    };
  });
  return {
    schemaVersion: 1,
    scope: "read_only_single_turn",
    sourceTurnId: turn.id,
    turnStatus: safeState(turn.status),
    itemsView: turn.itemsView ?? null,
    totalItems: items.length,
    totalQuestionItems,
    truncatedQuestionItems: totalQuestionItems > MAX_QUESTION_ITEMS,
    questions: questionDetails,
    conclusion: "question_metadata_only_cannot_prove_interaction_resolved",
    interpretation: "Matching IDs and later commands are observations, not proof that a question or permission request was resolved. An absent match is not proof the request is still pending. No recovery decision is made.",
    privacy: "Field names/types, allowlisted state/boolean values and truncated SHA-256 identifiers only. No prompt/question/answer/file/tool contents or raw request IDs.",
  };
}

export interface InteractionReadResult {
  turn?: CodexTurn;
  status: "found" | "not_found" | "malformed" | "too_large" | "unavailable" | "page_limit";
  pagesRead: number;
  turnsScanned: number;
}

/** Dedicated target-turn lookup, unlike recovery's boundary-stop reader.
 * Calls only thread/turns/list; never starts a turn or edits extension state. */
export async function readInteractionTurn(
  client: RpcReader, threadId: string, turnId: string,
): Promise<InteractionReadResult> {
  let cursor: string | null = null;
  let bytes = 0;
  let turnsScanned = 0;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const response: ThreadTurnsListResponse = await client.request("thread/turns/list", {
        threadId, limit: PAGE_SIZE, sortDirection: "desc", itemsView: "full",
        ...(cursor ? { cursor } : {}),
      }, 15_000);
      if (!obj(response) || !Array.isArray(response.data) ||
          !(typeof response.nextCursor === "string" || response.nextCursor === null)) {
        return { status: "malformed", pagesRead: page + 1, turnsScanned };
      }
      bytes += Buffer.byteLength(JSON.stringify(response), "utf8");
      if (bytes > MAX_BYTES) return { status: "too_large", pagesRead: page + 1, turnsScanned };
      for (const turn of response.data) {
        turnsScanned++;
        if (!obj(turn) || typeof turn.id !== "string" || !turn.id ||
            !Array.isArray(turn.items) || turn.itemsView !== "full") {
          return { status: "malformed", pagesRead: page + 1, turnsScanned };
        }
        if (turn.id === turnId) {
          return { turn: turn as unknown as CodexTurn, status: "found",
            pagesRead: page + 1, turnsScanned };
        }
      }
      if (response.nextCursor === null) return { status: "not_found",
        pagesRead: page + 1, turnsScanned };
      if (!response.nextCursor || seen.has(response.nextCursor)) return {
        status: "malformed", pagesRead: page + 1, turnsScanned };
      cursor = response.nextCursor;
      seen.add(cursor);
    } catch {
      // Errors may include paths or transport tokens: never report raw errors.
      return { status: "unavailable", pagesRead: page + 1, turnsScanned };
    }
  }
  return { status: "page_limit", pagesRead: MAX_PAGES, turnsScanned };
}
