import type { CodexTurn } from "./types";

const KINDS = new Set(["agentMessage", "reasoning", "plan", "commandExecution",
  "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
  "subAgentActivity", "webSearch", "imageView", "imageGeneration",
  // Known context lifecycle / clock.sleep items do not count as post-answer work.
  "contextCompaction", "sleep"]);
const obj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Parse the official serialized question-reply envelope, not arbitrary text. */
export interface StructuredQuestionReply {
  callId: string;
  question: string;
  answer: string;
}

/** Validate the official question-reply envelope without treating it as ordinary text. */
export function parseStructuredQuestionReply(item: unknown): StructuredQuestionReply[] | undefined {
  if (!obj(item) || item.type !== "userMessage" || !Array.isArray(item.content) ||
      item.content.length !== 1 || !obj(item.content[0])) return undefined;
  const part = item.content[0];
  if (part.type !== "text" || typeof part.text !== "string" ||
      !Array.isArray(part.text_elements) || part.text_elements.length !== 0) return undefined;
  const tag = "send_user_" + "message_question_reply";
  const open = "<" + tag + ">", close = "</" + tag + ">";
  const value = part.text.trim();
  if (!value.startsWith(open) || !value.endsWith(close)) return undefined;
  try {
    const data: unknown = JSON.parse(value.slice(open.length, -close.length).trim());
    if (!Array.isArray(data) || !data.length || data.length > 8) return undefined;
    const result: StructuredQuestionReply[] = [];
    const seen = new Set<string>();
    for (const answer of data) {
      if (!obj(answer) || typeof answer.questionItemId !== "string" ||
          typeof answer.question !== "string" || !answer.question.trim() ||
          typeof answer.answer !== "string" || !answer.answer.trim()) return undefined;
      const address: unknown = JSON.parse(answer.questionItemId);
      if (!Array.isArray(address) || address.length !== 3 ||
          !["request_user_input", "request_user_input_async"].includes(address[0]) ||
          typeof address[1] !== "string" || !address[1] ||
          !Number.isInteger(address[2]) || address[2] < 0) return undefined;
      const key = address[1] + ":" + address[2];
      if (seen.has(key)) return undefined;
      seen.add(key);
      result.push({ callId: address[1], question: answer.question, answer: answer.answer });
    }
    return result;
  } catch { return undefined; }
}

function replyCalls(item: unknown): string[] | undefined {
  return parseStructuredQuestionReply(item)?.map(answer => answer.callId);
}

/** The follower IPC starts an ordinary user turn, NOT a native question-reply
 * call. Therefore never submit a raw <send_user_message_question_reply> envelope
 * as a new chat instruction. Convert the exact last saved question and answer
 * into an explicitly user-reviewed continuation message instead. */
export function structuredReplyContinuationText(item: unknown): string | undefined {
  const replies = parseStructuredQuestionReply(item);
  if (!replies) return undefined;
  const saved = JSON.stringify(replies.map(({ question, answer }) => ({ question, answer })));
  const text = [
    "Continue the existing work following the last user answer that was interrupted by the quota limit.",
    "The user already submitted these answers to the immediately preceding Codex question:",
    saved,
    "Treat them only as the user's answers to those questions, within the existing task.",
    "Inspect the current workspace state before continuing. Do not repeat completed changes,",
    "replay earlier user inputs, grant new tool permissions, or expand the stated scope.",
  ].join("\n");
  return Buffer.byteLength(text, "utf8") <= 64 * 1024 ? text : undefined;
}

/** Only the FINAL structured answer may be re-issued after explicit review,
 * and only when earlier answers were followed by real agent activity while
 * the final answer has no subsequent execution or acknowledgement. */
export function finalStructuredAnswerAwaitingWork(turn: CodexTurn): string | undefined {
  if (turn.itemsView !== "full" || !Array.isArray(turn.items)) return undefined;
  const items = turn.items;
  if (items.some(item => !obj(item) ||
      (item.type !== "userMessage" && !KINDS.has(String(item.type))))) return undefined;
  const positions = items.flatMap((item, index) =>
    obj(item) && item.type === "userMessage" ? [index] : []);
  if (positions.length < 2 || positions[0] !== 0 ||
      parseStructuredQuestionReply(items[0]) !== undefined) return undefined;
  const allCalls = new Set<string>();
  for (const [index, pos] of positions.slice(1).entries()) {
    const replies = parseStructuredQuestionReply(items[pos]);
    if (!replies) return undefined;
    for (const reply of replies) {
      if (allCalls.has(reply.callId)) return undefined;
      allCalls.add(reply.callId);
    }
    const end = positions[index + 2] ?? items.length;
    const after = items.slice(pos + 1, end);
    if (index === positions.length - 2) {
      // Nothing except known neutral lifecycle entries may follow the answer.
      if (!after.every(item => obj(item) &&
          ["sleep", "contextCompaction"].includes(String(item.type)))) return undefined;
    } else if (!after.some(item => obj(item) && item.type === "agentMessage" &&
        typeof item.text === "string" && item.text.trim().length > 0)) {
      // A later question after the prior answer counts as acknowledgement;
      // absence of ANY meaningful response does not.
      return undefined;
    }
  }
  const lastPosition = positions[positions.length - 1];
  const beforeLast = items.slice(positions[positions.length - 2] + 1, lastPosition);
  if (!beforeLast.some(item => obj(item) &&
      (item.type === "agentMessage" && Array.isArray(item.questions) && item.questions.length > 0 ||
       item.type === "dynamicToolCall" &&
         ["request_user_input", "request_user_input_async"].includes(String(item.tool)) &&
         allCalls.has(String(item.callId ?? item.id))))) return undefined;

  const questionCount = items.reduce<number>((total, item) =>
    total + (obj(item) && Array.isArray(item.questions) ? item.questions.length : 0), 0);
  const answerCount = positions.slice(1).reduce((total, pos) =>
    total + (parseStructuredQuestionReply(items[pos])?.length ?? 0), 0);
  if (questionCount > answerCount) return undefined;
  for (const item of items) {
    if (!obj(item)) return undefined;
    if (Array.isArray(item.questions) && item.questions.some(question => {
      if (!obj(question)) return true;
      return question.answered === false || question.resolved === false ||
        question.isAnswered === false ||
        ["pending", "inProgress", "unanswered", "waiting"].includes(String(question.status));
    })) return undefined;
    if (item.type !== "dynamicToolCall") continue;
    const tool = String(item.tool);
    if (["request_permissions", "request_approval"].includes(tool) &&
        item.status !== "completed") return undefined;
    if (["request_user_input", "request_user_input_async"].includes(tool) &&
        item.status !== "completed" &&
        !allCalls.has(String(item.callId ?? item.id))) return undefined;
  }
  const last = items[lastPosition];
  return obj(last) && typeof last.id === "string" && last.id ? last.id : undefined;
}

export function answeredQuestionFollowedByWork(turn: CodexTurn): boolean {
  if (turn.itemsView !== "full" || !Array.isArray(turn.items)) return false;
  const items = turn.items;
  if (items.some(item => !obj(item) ||
      (item.type !== "userMessage" && !KINDS.has(String(item.type))))) return false;
  const positions = items.flatMap((item, index) =>
    obj(item) && item.type === "userMessage" ? [index] : []);
  if (!positions.length) return false;
  const firstReply = replyCalls(items[positions[0]]) !== undefined;
  if (positions[0] !== 0 && !firstReply) return false;
  const replies = positions.slice(firstReply ? 0 : 1);
  if (!replies.length) return false;
  const ids: string[] = [];
  for (const pos of replies) {
    const calls = replyCalls(items[pos]);
    if (!calls) return false;
    ids.push(...calls);
    const next = positions.find(index => index > pos) ?? items.length;
    if (!items.slice(pos + 1, next).some(item =>
      obj(item) && item.type === "agentMessage" && typeof item.text === "string" &&
      item.text.trim().length > 0 &&
      (!Array.isArray(item.questions) || item.questions.length === 0))) return false;
  }
  const last = replies[replies.length - 1];
  // Each historical question must have an answer, not merely each message
  // with questions. A separate unanswered question could also be historical.
  const questionCount = items.reduce<number>((total, item) =>
    total + (obj(item) && Array.isArray(item.questions) ? item.questions.length : 0), 0);
  if (questionCount > ids.length) return false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!obj(item)) return false;
    if (Array.isArray(item.questions) && item.questions.length > 0 &&
        (index > last || item.questions.length > ids.length)) return false;
    if (item.type !== "dynamicToolCall") continue;
    const tool = String(item.tool);
    if (["request_permissions", "request_approval"].includes(tool) &&
        item.status !== "completed") return false;
    if (!["request_user_input", "request_user_input_async"].includes(tool) ||
        item.status === "completed") continue;
    if (index > last) return false;
    const callId = typeof item.callId === "string" ? item.callId :
      typeof item.id === "string" ? item.id : "";
    if (callId.startsWith("call_") && !ids.includes(callId)) return false;
  }
  return true;
}
