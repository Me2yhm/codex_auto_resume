const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControllerHarness, createVscodeMock, loadWithMocks } = require("./helpers/controllerHarness.js");
const { claimWorkResume, readWorkResumeDispatch } = require("../dist/workRecoveryDispatch.js");
const { RecoveryCoordinator, readRecoveryPriority } = require("../dist/recoveryCoordination.js");
const { readQuotaPrimerSendJournal } = require("../dist/quotaPrimerSendJournal.js");

const ARMED_KEY = "codexAutoResume.armed";
const NOW = 1_900_000_000_000;
const THREAD_ID = "final-review-work";
const TURN_ID = "final-review-interruption";
const ORIGINAL = { id: TURN_ID, status: "interrupted", error: null, startedAt: null, completedAt: null };

function armed(changes = {}) {
  return { threadId: THREAD_ID, cwd: "/workspace", armedAtMs: NOW - 60_000,
    resetAtMs: NOW + 3_600_000, reason: "usageLimitExceeded", interruptedTurnId: TURN_ID, ...changes };
}

function request(method) {
  if (method === "account/rateLimits/read") return { ordinaryUsageAllowed: true, rateLimits: {
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: NOW / 1000 + 3_600 },
    secondary: null, rateLimitReachedType: null,
  } };
  if (method === "thread/turns/list") return { data: [ORIGINAL], nextCursor: null };
  if (method === "thread/list") return { data: [{ id: THREAD_ID, cwd: "/workspace", preview: "Real work",
    updatedAt: Date.now() / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" } }], nextCursor: null };
  throw new Error(`Unexpected ${method}`);
}

function harness(t, options = {}) {
  const h = createControllerHarness({ workspaceValues: { [ARMED_KEY]: armed(options.armed) }, request, ...options });
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  t.after(h.dispose);
  return Object.assign(h, { state: () => h.context.workspaceState.get(ARMED_KEY) });
}

test("an adopting window retries a definitively unsent host dispatch after its creator disables", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-"));
  const windows = [];
  t.after(async () => {
    for (const h of windows) {
      await h.controller.recovery.clear().catch(() => {});
      h.dispose();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  let sending;
  let release;
  const entered = new Promise((resolve) => { sending = resolve; });
  const outcome = new Promise((resolve) => { release = resolve; });
  const options = { realCoordination: true, globalStoragePath: root };
  const creator = harness(t, { ...options, send: async () => { sending(); return outcome; } });
  const adopter = harness(t, options);
  windows.push(creator, adopter);
  await Promise.all(windows.map((h) => h.tick()));
  now += 10_000;
  const pendingTick = creator.tick();
  await entered;
  await adopter.tick();
  assert.ok(adopter.state().dispatchPending);
  assert.equal(adopter.sends.length, 0);

  release(false); // Official IPC proves the creator did not dispatch a turn.
  await pendingTick;
  assert.equal(creator.state().dispatchPending, undefined);
  await creator.controller.disable();
  assert.equal((await fs.readdir(path.join(root, "work-resume-dispatches"))).length, 0);

  // The remaining window must leave the revoked attempt and perform a fresh
  // two-read quota confirmation before making one controlled retry.
  for (const delay of [60_000, 10_000, 10_000]) {
    now += delay;
    await adopter.tick();
  }
  assert.equal(adopter.sends.length, 1);
  assert.equal(adopter.sends[0].threadId, THREAD_ID);
});

test("a legacy account-only armed interruption cannot automatically resume a manual Stop", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const h = harness(t, { armed: { reason: "rateLimitReached", interruptedTurnId: undefined } });
  await h.tick();
  now += 10_000;
  await h.tick();
  assert.equal(h.sends.length, 0);
});

test("reading a missing work dispatch never creates a claim or storage directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expected = { threadId: THREAD_ID, beforeTurnId: TURN_ID };
  assert.equal(await readWorkResumeDispatch(root, expected), undefined);
  assert.deepEqual(await fs.readdir(root), []);
});

test("dispatch reads distinguish a live claim, known-unsent release, and its replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expected = { threadId: THREAD_ID, beforeTurnId: TURN_ID };
  const first = await claimWorkResume(root, { ...expected, sentAtMs: NOW });
  assert.deepEqual(await readWorkResumeDispatch(root, expected), first.record);
  await first.releaseUnsent();
  assert.equal(await readWorkResumeDispatch(root, expected), undefined);
  const replacement = await claimWorkResume(root, { ...expected, sentAtMs: NOW + 60_000 });
  assert.notEqual(replacement.record.token, first.record.token);
  assert.deepEqual(await readWorkResumeDispatch(root, expected), replacement.record);
});

test("dispatch reads reject corrupt records and filesystem failures without replacing them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expected = { threadId: THREAD_ID, beforeTurnId: TURN_ID };
  await claimWorkResume(root, { ...expected, sentAtMs: NOW });
  const directory = path.join(root, "work-resume-dispatches");
  const [name] = await fs.readdir(directory);
  const filename = path.join(directory, name);
  await fs.writeFile(filename, "{");
  await assert.rejects(readWorkResumeDispatch(root, expected));
  assert.equal(await fs.readFile(filename, "utf8"), "{");
  const storageFile = path.join(root, "storage-is-a-file");
  await fs.writeFile(storageFile, "not a directory");
  await assert.rejects(readWorkResumeDispatch(storageFile, expected));
});

test("official owner discovery rechecks recovery priority immediately before starting a Primer turn", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-guard-"));
  const recovery = new RecoveryCoordinator(root, "/another-workspace", { appendLine() {} });
  t.after(async () => {
    await recovery.clear();
    recovery.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  let guardCalls = 0;
  let startCalls = 0;
  let disposed = false;
  class Ipc {
    async connect() {}
    async discoverOwner(threadId) {
      assert.equal(threadId, "dedicated-primer");
      // Work can become Armed after Primer's journal/preflight, while the
      // official helper waits for owner discovery to finish.
      await recovery.set({ phase: "armed", threadId: THREAD_ID });
      return "official-primer-owner";
    }
    async startTurn() { startCalls += 1; }
    dispose() { disposed = true; }
  }
  const official = loadWithMocks(path.resolve(__dirname, "../dist/officialCodexUi.js"), {
    vscode: createVscodeMock(),
    "./codexUiIpc": { CodexUiIpcClient: Ipc, readCodexUiIpcVersions: () => ({ ownerDiscovery: 2, startTurn: 3 }) },
  });
  await assert.rejects(official.trySendTurnThroughExistingOfficialOwner(
    "dedicated-primer", "Prime", { appendLine() {} }, "final-review", { model: "luna" },
    async () => {
      guardCalls += 1;
      const priority = await readRecoveryPriority(root);
      if (priority.status !== "clear") throw new Error("work recovery has priority");
    },
  ), /work recovery has priority/);
  assert.equal(guardCalls, 1);
  assert.equal(startCalls, 0);
  assert.equal(disposed, true);
});

test("Primer cancels and clears unsent intent when work arms during official owner discovery", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const duration = 300 * 60_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-final-review-primer-"));
  const recovery = new RecoveryCoordinator(root, "/another-workspace", { appendLine() {} });
  t.after(async () => {
    await recovery.clear();
    recovery.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  let discoveryCalls = 0;
  let startCalls = 0;
  class Ipc {
    async connect() {}
    async discoverOwner() {
      discoveryCalls += 1;
      await recovery.set({ phase: "armed", threadId: THREAD_ID });
      return "official-primer-owner";
    }
    async startTurn() { startCalls += 1; }
    dispose() {}
  }
  const official = loadWithMocks(path.resolve(__dirname, "../dist/officialCodexUi.js"), {
    vscode: createVscodeMock(),
    "./codexUiIpc": { CodexUiIpcClient: Ipc, readCodexUiIpcVersions: () => ({ ownerDiscovery: 2, startTurn: 3 }) },
  });
  const primer = createControllerHarness({
    modulePath: path.resolve(__dirname, "../dist/quotaPrimerController.js"), exportName: "QuotaPrimerController",
    realCoordination: true, globalStoragePath: root,
    globalValues: { "codexAutoResume.quotaPrimer.state": {
      threadId: "dedicated-primer", primary: { trackedResetAtMs: NOW - 120_000,
        probeObservedAtMs: NOW - 60_000, probeResetAtMs: NOW - 60_000 + duration },
    } },
    configuration: { "codexAutoResume.quotaPrimer.enabled": true, "codexAutoResume.quotaPrimer.jitterSeconds": 0 },
    mocks: { "./officialCodexUi": official },
    request(method) {
      if (method === "account/rateLimits/read") return { ordinaryUsageAllowed: true, rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: (now + duration) / 1000 },
        secondary: null, rateLimitReachedType: null,
      } };
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "model/list") return { data: [{ id: "luna", model: "luna", displayName: "Luna", hidden: false,
        isDefault: true, defaultReasoningEffort: "minimal", supportedReasoningEfforts: [{ reasoningEffort: "minimal" }] }], nextCursor: null };
      if (method === "thread/turns/list") return { data: [{ ...ORIGINAL, id: "previous-primer", status: "completed" }], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    },
  });
  t.after(primer.dispose);
  primer.controller.waitForMotionSample = async (observedAtMs) => { now = observedAtMs + 15_000; };
  await primer.tick();
  assert.equal(discoveryCalls, 1, "the candidate reached official owner discovery");
  assert.equal(startCalls, 0);
  assert.equal(primer.requests.some(({ method }) => method === "turn/start"), false);
  assert.equal((await readQuotaPrimerSendJournal(root)).journal.pending, undefined);
});
