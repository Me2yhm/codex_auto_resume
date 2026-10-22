import type { CodexTurn } from "./types";

const KINDS = new Set(["agentMessage", "reasoning", "plan", "commandExecution",
  "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
  "subAgentActivity", "webSearch", "imageView", "imageGeneration"]);
const obj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Parse the official serialized question-reply envelope, not arbitrary text. */
function replyCalls(item: unknown): string[] | undefined {
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
    const ids: string[] = [];
    for (const answer of data) {
      if (!obj(answer) || typeof answer.questionItemId !== "string" ||
          typeof answer.question !== "string" || !answer.question.trim() ||
          typeof answer.answer !== "string" || !answer.answer.trim()) return undefined;
      const address: unknown = JSON.parse(answer.questionItemId);
      if (!Array.isArray(address) || address.length !== 3 ||
          !["request_user_input", "request_user_input_async"].includes(address[0]) ||
          typeof address[1] !== "string" || !address[1] ||
          !Number.isInteger(address[2]) || address[2] < 0) return undefined;
      ids.push(address[1]);
    }
    return ids;
  } catch { return undefined; }
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
  const questionCount = items.reduce((total, item) =>
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
