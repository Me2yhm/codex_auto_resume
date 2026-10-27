const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInteractionTrace, readInteractionTurn } =
  require("../dist/recoveryInteractionTrace");

const TURN_ID = "01a175fd-c060-7123-86a0-16654b6ca1a6";
const THREAD_ID = "01a16185-f085-7613-8d20-8da801fecca3";
const SECRET = {
  prompt: "SECRET_ORIGINAL_PROMPT",
  title: "SECRET_PRIVATE_AUTHORIZATION_QUESTION",
  answer: "SECRET_ANSWER_DO_NOT_SHARE",
  path: "C:\\SENSITIVE\\USER\\internal-plan.txt",
  command: "cat SECRET_COMMAND_AND_PASSWORD",
  id: "call_SECRET_INTERNAL_ID",
};
const user = text => ({
  type: "userMessage", id: "message-id", content: [{ type: "text", text, text_elements: [] }],
});
const turn = items => ({
  id: TURN_ID, status: "failed", error: { codexErrorInfo: "usageLimitExceeded" },
  itemsView: "full", items,
});
function checkNoSecrets(report) {
  const serialized = JSON.stringify(report);
  for (const value of Object.values(SECRET)) {
    assert.equal(serialized.includes(value), false, "Leaked " + value);
  }
  assert.equal(serialized.includes("PASSWORD"), false);
}

test("G4-like question indices 12 and 86 show metadata only, no request content", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    type: i % 2 ? "reasoning" : "commandExecution",
    id: "item-" + i, command: SECRET.command, content: SECRET.prompt,
    result: { stdout: SECRET.answer },
  }));
  items[0] = user(SECRET.prompt);
  for (const index of [12, 86]) {
    items[index] = {
      type: "agentMessage", status: null, text: SECRET.prompt, questions: [
        { title: SECRET.title, answer: SECRET.answer, opaqueInfo: {
          userPath: SECRET.path, raw: SECRET.answer,
        } },
      ],
    };
  }
  const report = buildInteractionTrace(turn(items));
  assert.equal(report.totalQuestionItems, 2);
  assert.deepEqual(report.questions.map(q => q.itemIndex), [12, 86]);
  assert.equal(report.questions[0].questionDetails[0].questionIndex, 0);
  assert.equal(report.questions[0].unknown, 1);
  assert.ok(report.questions[0].laterProgressItems > 0);
  assert.equal(report.questions[0].matchingRecords.length, 0);
  assert.equal(report.conclusion, "question_metadata_only_cannot_prove_interaction_resolved");
  assert.ok(report.questions[0].questionDetails[0].fields.some(x => x.field === "opaqueInfo"));
  assert.ok(report.questions[0].questionDetails[0].fields.some(x => x.field === "title" && x.type === "string"));
  assert.equal(report.questions[1].neighborhood.length, 7);
  checkNoSecrets(report);
});

test("structured question ID can correlate with later reply and tool, without exposing identifiers or answers", () => {
  const questionItemId = JSON.stringify(["request_user_input_async", SECRET.id, 0]);
  const reply = "<send_user_message_question_reply>\n" + JSON.stringify([{
    questionItemId, question: SECRET.title, answer: SECRET.answer,
  }]) + "\n</send_user_message_question_reply>";
  const t = turn([
    user(SECRET.prompt),
    { type: "dynamicToolCall", id: "tool", tool: "request_user_input_async",
      callId: SECRET.id, status: "completed" },
    { type: "agentMessage", questions: [{ questionItemId, label: SECRET.title }] },
    user(reply),
    { type: "commandExecution", command: SECRET.command, status: "completed" },
  ]);
  const report = buildInteractionTrace(t);
  const question = report.questions[0];
  assert.ok(question.questionDetails[0].ids.some(id =>
    id.field === "questionItemId.call" && id.digest.startsWith("hmac-sha256:")));
  const before = question.matchingRecords.find(record => record.itemIndex === 1);
  const after = question.matchingRecords.find(record => record.itemIndex === 3);
  assert.equal(before.relativeOrder, "before_question");
  assert.equal(before.structuredReplyMatch, false);
  assert.equal(before.itemType, "dynamicToolCall");
  assert.equal(before.itemStatus, "completed");
  assert.equal(after.relativeOrder, "after_question");
  assert.equal(after.structuredReplyMatch, true);
  assert.equal(after.itemType, "userMessage");
  assert.equal(after.itemStatus, null);
  assert.ok(question.matchingRecords.every(record =>
    record.evidenceType === "identifier_match_only_not_resolution_proof"));
  assert.equal(report.conclusion, "question_metadata_only_cannot_prove_interaction_resolved");
  checkNoSecrets(report);
});

test("a later unrelated reply is not mistaken for resolution of a question", () => {
  const questionId = JSON.stringify(["request_user_input_async", "call_for_question", 0]);
  const unrelatedId = JSON.stringify(["request_user_input_async", "call_unrelated", 0]);
  const message = "<send_user_message_question_reply>" + JSON.stringify([{
    questionItemId: unrelatedId, question: SECRET.title, answer: SECRET.answer,
  }]) + "</send_user_message_question_reply>";
  const report = buildInteractionTrace(turn([
    user(SECRET.prompt),
    { type: "agentMessage", questions: [{ questionItemId: questionId }] },
    user(message),
    { type: "commandExecution", id: "later-tool", status: "completed",
      command: SECRET.command },
  ]));
  assert.equal(report.questions.length, 1);
  assert.equal(report.questions[0].matchingRecords.length, 0);
  assert.equal(report.questions[0].unknown, 1);
  assert.equal(report.conclusion, "question_metadata_only_cannot_prove_interaction_resolved");
  checkNoSecrets(report);
});

test("explicit state booleans are visible, conflicting or arbitrary statuses are not leaked", () => {
  const report = buildInteractionTrace(turn([
    user(SECRET.prompt),
    { type: "agentMessage", status: "completed", questions: [
      { answered: true, resolved: false, status: "OTHER_SECRET_STATUS", text: SECRET.title },
    ] },
  ]));
  const q = report.questions[0].questionDetails[0];
  assert.deepEqual(q.stateFields, [
    { field: "answered", value: true }, { field: "resolved", value: false },
    { field: "status", value: "other" },
  ]);
  assert.equal(report.questions[0].itemStatus, "completed");
  checkNoSecrets(report);
});

test("unknown item types and sensitive-looking field names are not exposed", () => {
  const report = buildInteractionTrace(turn([
    user(SECRET.prompt),
    { type: "SECRET_UNKNOWN_DYNAMIC_ITEM_TYPE", questions: [
      { id: "SECRET_LOW_ENTROPY_ID", password_SECRET_KEY: "SECRET_VAL",
        questionState: "SECRET_BLOB", answer: SECRET.answer },
    ] },
  ]));
  const details = report.questions[0];
  assert.equal(details.itemType, "unrecognized_item");
  assert.ok(details.questionDetails[0].fields.some(f => f.field.startsWith("field_hmac-sha256:")));
  assert.equal(JSON.stringify(report).includes("SECRET_UNKNOWN_DYNAMIC_ITEM_TYPE"), false);
  assert.equal(JSON.stringify(report).includes("password_SECRET_KEY"), false);
  assert.equal(JSON.stringify(report).includes("SECRET_LOW_ENTROPY_ID"), false);
  checkNoSecrets(report);
});

test("pending tool is marked without exposing tool arguments or raw request ID", () => {
  const report = buildInteractionTrace(turn([
    user(SECRET.prompt),
    { type: "dynamicToolCall", tool: "request_permissions", status: "inProgress",
      requestId: SECRET.id, arguments: { reason: SECRET.title } },
    { type: "agentMessage", questions: [{ id: SECRET.id, resolved: false, title: SECRET.title }] },
  ]));
  assert.equal(report.questions[0].pendingTool, true);
  assert.equal(report.questions[0].itemType, "dynamicToolCall");
  assert.equal(report.questions[0].itemStatus, "inProgress");
  assert.equal(report.questions[1].explicitlyPending, 1);
  checkNoSecrets(report);
});

test("question diagnostics are bounded to 16 groups and 8 questions each", () => {
  const items = [user(SECRET.prompt)];
  for (let i = 0; i < 50; i++) items.push({
    type: "agentMessage",
    questions: Array.from({ length: 20 }, (_, j) => ({ title: SECRET.title, id: i + "/" + j })),
  });
  const report = buildInteractionTrace(turn(items));
  assert.equal(report.totalQuestionItems, 50);
  assert.equal(report.questions.length, 16);
  assert.equal(report.truncatedQuestionItems, true);
  assert.ok(report.questions.every(q => q.questionDetails.length === 8));
  checkNoSecrets(report);
});

test("target-turn reader uses only bounded read-only full-history calls across pages", async () => {
  const calls = [];
  const reader = {
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      if (params.cursor === undefined) {
        return { data: [turn([user("another turn")])].map(x => ({ ...x, id: "newer" })),
          nextCursor: "page-2" };
      }
      assert.equal(params.cursor, "page-2");
      return { data: [turn([user(SECRET.prompt)])], nextCursor: null };
    },
  };
  const result = await readInteractionTurn(reader, THREAD_ID, TURN_ID);
  assert.equal(result.status, "found");
  assert.equal(result.turn.id, TURN_ID);
  assert.equal(result.pagesRead, 2);
  assert.deepEqual(calls.map(x => x.method), ["thread/turns/list", "thread/turns/list"]);
  assert.ok(calls.every(x => x.params.itemsView === "full" &&
    x.params.threadId === THREAD_ID && x.params.sortDirection === "desc" &&
    x.timeout === 15000));
});

test("target-turn reader refuses missing, malformed, oversized, cyclic or unavailable history", async () => {
  const notFound = await readInteractionTurn({ async request() {
    return { data: [turn([])].map(x => ({ ...x, id: "other" })), nextCursor: null };
  } }, THREAD_ID, TURN_ID);
  assert.equal(notFound.status, "not_found");

  const malformed = await readInteractionTurn({ async request() {
    return { data: [{ id: TURN_ID, itemsView: "summary", items: [] }],
      nextCursor: null };
  } }, THREAD_ID, TURN_ID);
  assert.equal(malformed.status, "malformed");

  const oversized = await readInteractionTurn({ async request() {
    return { data: [{ ...turn([]), id: TURN_ID, extra: "x".repeat(4 * 1024 * 1024) }],
      nextCursor: null };
  } }, THREAD_ID, TURN_ID);
  assert.equal(oversized.status, "too_large");

  const cyclic = await readInteractionTurn({ async request() {
    return { data: [], nextCursor: "same" };
  } }, THREAD_ID, TURN_ID);
  assert.equal(cyclic.status, "malformed");

  const unavailable = await readInteractionTurn({ async request() {
    throw new Error("SECRET_NETWORK_URL_WITH_TOKEN");
  } }, THREAD_ID, TURN_ID);
  assert.deepEqual(unavailable, {
    status: "unavailable", pagesRead: 1, turnsScanned: 0,
  });
  checkNoSecrets(unavailable);
});
