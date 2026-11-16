const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-study-bridge-"));
const log = [];
let availableModels = [];
let clients = [];
const output = { appendLine(value) { log.push(value); } };

class MockCodexClient extends EventEmitter {
  constructor(exe, out, info) {
    super();
    assert.equal(exe, "bundled-codex.exe");
    clients.push(this);
    this.methods = [];
  }
  async start() {}
  async request(method, params) {
    this.methods.push({ method, params });
    if (method === "model/list") {
      return { data: availableModels, nextCursor: null };
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-123" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-123", status: "inProgress" } };
    }
    throw new Error("Unexpected mock RPC method: " + method);
  }
  dispose() { this.disposed = true; }
}

const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: (_key, fallback) => true }),
  },
  window: { showInformationMessage: () => undefined },
};

const actualLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.endsWith("studyReviewTaskBridge.js")) {
    if (request === "vscode") return vscode;
    if (request === "./codexRpcClient") return { CodexRpcClient: MockCodexClient };
    if (request === "./codexLocator") return { resolveCodexExecutable: () => "bundled-codex.exe" };
    if (request === "./officialCodexUi") {
      return { surfaceOfficialCodexThread: async () => {} };
    }
  }
  return actualLoad.call(this, request, parent, isMain);
};
const { StudyReviewTaskBridge } = require("../dist/studyReviewTaskBridge.js");
Module._load = actualLoad;

const base = path.join(root, ".tmp", "p5");
const inputFolder = path.join(base, "codex-bridge", "requests");
const outputFolder = path.join(base, "codex-bridge", "results");
const tasks = path.join(base, "quiz-tasks");
const reviews = path.join(base, "quiz-reviews");

function queue(id) {
  fs.mkdirSync(inputFolder, { recursive: true });
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(reviews, { recursive: true });
  const task = path.join(tasks, id + ".json");
  fs.writeFileSync(task, JSON.stringify({ kind: "review_required" }));
  fs.writeFileSync(path.join(inputFolder, id + ".json"), JSON.stringify({
    version: 1, request_id: id,
    kind: "study_review", model: "Luna Max",
    course_id: "course1", lesson_id: "quiz1",
    task_file: task, review_output: path.join(reviews, id + ".md"),
  }));
}

function status(id) {
  const file = path.join(outputFolder, id + ".json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function waitUntil(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail("Expected bridge state not observed");
}

test("queued study task is dispatched with verified Luna Max and real turn ID", async (t) => {
  const id = "a".repeat(24);
  availableModels = [
    { id: "luna-mini", model: "luna-mini", displayName: "Luna Mini" },
    { id: "luna-max", model: "luna-max", displayName: "Luna Max" },
  ];
  queue(id);
  const bridge = new StudyReviewTaskBridge(output);
  t.after(() => bridge.dispose());
  bridge.start();
  await waitUntil(() => status(id)?.status === "accepted");
  assert.equal(status(id).model_selected, "Luna Max");
  assert.equal(status(id).model_id, "luna-max");
  assert.equal(status(id).thread_id, "thread-123");
  assert.equal(status(id).turn_id, "turn-123");
  const client = clients[clients.length - 1];
  const started = client.methods.find((m) => m.method === "thread/start");
  const sent = client.methods.find((m) => m.method === "turn/start");
  assert.equal(started.params.model, "luna-max");
  assert.equal(sent.params.model, "luna-max");
  assert.match(sent.params.input[0].text, /agent-browser/);
  assert.match(sent.params.input[0].text, /待本人作答/);
  assert.match(sent.params.input[0].text, /不得点击答题选项/);
  client.emit("notification", "turn/completed", {
    threadId: "thread-123", turn: { id: "turn-123", status: "completed" },
  });
  await waitUntil(() => status(id)?.status === "completed");
  assert.equal(client.disposed, true);
  assert.equal(fs.existsSync(path.join(inputFolder, id + ".json")), false);
  assert.equal(fs.existsSync(path.join(base, "codex-bridge", "bridge-ready.json")), true);
});

test("absent Luna Max fails closed before thread/start or turn/start", async (t) => {
  const id = "b".repeat(24);
  availableModels = [
    { id: "luna-mini", model: "luna-mini", displayName: "Luna Mini" },
  ];
  queue(id);
  const bridge = new StudyReviewTaskBridge(output);
  t.after(() => bridge.dispose());
  bridge.start();
  await waitUntil(() => status(id)?.status === "failed");
  assert.equal(status(id).error_code, "luna_max_unavailable");
  const client = clients[clients.length - 1];
  assert.equal(client.methods.some((m) => m.method === "thread/start"), false);
  assert.equal(client.methods.some((m) => m.method === "turn/start"), false);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
