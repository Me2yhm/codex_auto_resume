const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  parseStudyReviewRequest, selectLunaMax, buildStudyReviewPrompt, isInside,
} = require("../dist/studyReviewBridgeProtocol.js");

const workspace = path.join(os.tmpdir(), "codex-bridge-fixture");
const taskFile = path.join(workspace, ".tmp", "p5", "quiz-tasks", "abc.json");
const reviewOutput = path.join(workspace, ".tmp", "p5", "quiz-reviews", "abc.md");
const envelope = () => ({
  version:1, request_id:"a".repeat(24), kind:"study_review", model:"Luna Max",
  course_id:"course_1", lesson_id:"quiz_2",
  task_file:taskFile, review_output:reviewOutput,
});

test("model selection is exact and has no silent fallback", () => {
  const models = [
    {id:"luna-mini",model:"luna-mini",displayName:"Luna Mini"},
    {id:"luna-max",model:"luna-max",displayName:"Luna Max"},
    {id:"other",model:"other",displayName:"Default",isDefault:true},
  ];
  assert.equal(selectLunaMax(models).model,"luna-max");
  assert.throws(() => selectLunaMax(models.slice(0,1)),/not found/);
  assert.throws(() => selectLunaMax([models[1],models[1]]),/ambiguous/);
});

test("study review protocol validates task metadata and private workspace paths", () => {
  assert.deepEqual(parseStudyReviewRequest(envelope(),workspace),envelope());
  for (const changes of [
    {kind:"arbitrary_script"}, {model:"Luna Mini"},
    {request_id:"../unsafe"}, {lesson_id:"../evil"},
    {review_output:path.join(workspace,"outside.md")},
    {task_file:path.join(workspace,".tmp","p5","quiz-tasks","..","..","passwd.json")},
  ]) {
    assert.throws(() => parseStudyReviewRequest({...envelope(),...changes},workspace));
  }
  assert.equal(isInside(path.join(workspace,".tmp","p5","quiz-tasks","a.json"),path.join(workspace,".tmp","p5","quiz-tasks")),true);
  assert.equal(isInside(workspace,workspace),false);
});

test("fixed study prompt provides only analysis not formal assessment submission", () => {
  const prompt=buildStudyReviewPrompt(envelope());
  assert.match(prompt,/agent-browser/);
  assert.match(prompt,/题号/);
  assert.match(prompt,/答案/);
  assert.match(prompt,/简短解析/);
  assert.match(prompt,/待本人作答/);
  assert.match(prompt,/不得点击答题选项/);
  assert.match(prompt,/不得推断正式考核的选项/);
});
