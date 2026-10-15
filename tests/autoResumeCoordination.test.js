const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");
const { readRecoveryPriority } = require("../dist/recoveryCoordination.js");

const ARMED_KEY = "codexAutoResume.armed";
const PENDING_KEY = "codexAutoResume.pendingQuotaCandidate";
const NOW = 1_900_000_000_000;
const THREAD_ID = "work-awaiting-quota";
const ORIGINAL_TURN = "original-quota-failed-turn";

function armed(changes = {}) {
  return {
    threadId: THREAD_ID,
    cwd: "/workspace",
    armedAtMs: NOW - 60_000,
    resetAtMs: NOW + 3_600_000,
    reason: "usageLimitExceeded",
    interruptedTurnId: ORIGINAL_TURN,
    ...changes,
  };
}

function turn(id = ORIGINAL_TURN, status = "interrupted", codexErrorInfo) {
  return {
    id, status,
    error: codexErrorInfo ? { codexErrorInfo, message: "Quota exhausted", additionalDetails: null } : null,
    startedAt: null,
    completedAt: null,
  };
}

function quota(available) {
  return {
    ordinaryUsageAllowed: available,
    rateLimits: {
      primary: { usedPercent: available ? 1 : 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 3_600 },
      secondary: null,
      rateLimitReachedType: null,
    },
  };
}

async function storage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auto-recovery-coordination-"));
  const harnesses = [];
  t.after(async () => {
    for (const h of harnesses) {
      await h.controller.recovery.clear().catch(() => {});
      h.dispose();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, harnesses };
}

function harnessInStorage(t, shared, options = {}) {
  let response = options.response ?? new Error("quota endpoint offline");
  let turns = options.turns ?? [turn()];
  const h = createControllerHarness({
    realCoordination: true,
    globalStoragePath: shared.root,
    workspaceFolders: options.workspaceFolders,
    workspaceValues: options.workspaceValues,
    request(method, params) {
      if (method === "account/rateLimits/read") {
        if (response instanceof Error) throw response;
        return response;
      }
      if (method === "thread/turns/list") return { data: turns, nextCursor: null };
      assert.equal(method, "thread/list");
      return {
        data: [{ id: THREAD_ID, cwd: "/workspace", preview: "Real work", updatedAt: Date.now() / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" } }],
        nextCursor: null,
      };
    },
  });
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  shared.harnesses.push(h);
  return Object.assign(h, {
    setResponse(value) { response = value; },
    setTurns(value) { turns = value; },
    state: () => h.context.workspaceState.get(ARMED_KEY),
  });
}

async function expectPriority(root, phase, threadId = THREAD_ID) {
  const result = await readRecoveryPriority(root);
  assert.equal(result.status, "active");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].phase, phase);
  assert.equal(result.records[0].threadId, threadId);
  return result;
}

for (const [label, phase, workspaceValues, turns] of [
  ["pending interruption", "pending", { [PENDING_KEY]: { threadId: THREAD_ID, cwd: "/workspace", turnId: ORIGINAL_TURN, observedAtMs: NOW - 60_000, reason: "usageLimitExceeded" } }, [turn()]],
  ["armed work", "armed", { [ARMED_KEY]: armed() }, [turn()]],
  ["accepted dispatch awaiting discovery", "verifying", { [ARMED_KEY]: armed({ dispatchPending: { beforeTurnId: ORIGINAL_TURN, sentAtMs: NOW - 10_000 } }) }, [turn()]],
  ["tracked resume turn", "verifying", { [ARMED_KEY]: armed({ resumeTurnId: "tracked-resume", resumeStartedAtMs: NOW - 10_000 }) }, [turn("tracked-resume")]],
]) {
  test(`restored ${label} publishes same-host priority despite account network failure`, async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const shared = await storage(t);
    const h = harnessInStorage(t, shared, { workspaceValues, turns });
    await h.tick();
    await expectPriority(shared.root, phase);
    assert.equal(h.sends.length, 0);
  });
}

test("priority follows quota arming, accepted dispatch, tracked turn, and completed Disarm", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const shared = await storage(t);
  const h = harnessInStorage(t, shared, { response: quota(false), turns: [turn(ORIGINAL_TURN, "failed", "usageLimitExceeded")] });
  await h.tick();
  await expectPriority(shared.root, "armed");

  h.setResponse(quota(true));
  await h.tick();
  now += 10_000;
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.ok(h.state().dispatchPending);
  await expectPriority(shared.root, "verifying");

  h.setTurns([turn("resumed-work"), turn(ORIGINAL_TURN)]);
  await h.tick();
  assert.equal(h.state().resumeTurnId, "resumed-work");
  await expectPriority(shared.root, "verifying");

  h.setTurns([turn("resumed-work", "completed"), turn(ORIGINAL_TURN)]);
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
  assert.equal(h.sends.length, 1);
});

test("Disable clears the controller's same-host priority", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const shared = await storage(t);
  const h = harnessInStorage(t, shared, { workspaceValues: { [ARMED_KEY]: armed() } });
  await h.tick();
  await expectPriority(shared.root, "armed");
  await h.controller.disable();
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
  assert.equal(h.state(), undefined);
});

test("Dispose eventually removes same-host priority without clearing another window's registration", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const shared = await storage(t);
  const first = harnessInStorage(t, shared, { workspaceFolders: ["/workspace/one"], workspaceValues: { [ARMED_KEY]: armed() } });
  const secondThread = "another-window-work";
  const second = harnessInStorage(t, shared, {
    workspaceFolders: ["/workspace/two"],
    workspaceValues: { [ARMED_KEY]: armed({ threadId: secondThread }) },
  });
  await first.tick();
  await second.tick();
  const both = await readRecoveryPriority(shared.root);
  assert.equal(both.status, "active");
  assert.equal(both.records.length, 2);

  first.dispose();
  let remaining;
  for (let poll = 0; poll < 20; poll += 1) {
    remaining = await readRecoveryPriority(shared.root);
    if (remaining.status === "active" && remaining.records.length === 1) break;
    await new Promise(setImmediate);
  }
  assert.equal(remaining.status, "active");
  assert.equal(remaining.records.length, 1);
  assert.equal(remaining.records[0].threadId, secondThread);
  await second.controller.disable();
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
});

test("an unreadable coordination storage does not lose armed work or prevent confirmed UI recovery", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const shared = await storage(t);
  // A regular file cannot hold a registry directory. This also works when
  // tests run as root, unlike a permission-bit-only unreadability fixture.
  const brokenStorage = path.join(shared.root, "storage-is-a-file");
  await fs.writeFile(brokenStorage, "not a directory");
  const broken = { root: brokenStorage, harnesses: shared.harnesses };
  const h = harnessInStorage(t, broken, { workspaceValues: { [ARMED_KEY]: armed() }, response: quota(true) });
  await h.tick();
  assert.equal(h.state().threadId, THREAD_ID);
  assert.equal(h.sends.length, 0);
  assert.equal((await readRecoveryPriority(brokenStorage)).status, "unknown");
  now += 10_000;
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.ok(h.state().dispatchPending);
  assert.equal(h.state().threadId, THREAD_ID);
  assert.ok(h.logs.some((line) => line.includes("registration unavailable")));
});

test("Disable and re-enable while an old turn read is pending cannot resurrect its cleared recovery state", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const shared = await storage(t);
  const h = harnessInStorage(t, shared);
  let entered;
  let release;
  const observed = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  h.setRequestHandler(async (method) => {
    if (method === "account/rateLimits/read") return quota(false);
    if (method === "thread/list") {
      return {
        data: [{ id: THREAD_ID, cwd: "/workspace", preview: "Real work", updatedAt: NOW / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" } }],
        nextCursor: null,
      };
    }
    assert.equal(method, "thread/turns/list");
    entered();
    await barrier;
    return { data: [turn(ORIGINAL_TURN, "failed", "usageLimitExceeded")], nextCursor: null };
  });

  const oldTick = h.tick();
  await observed;
  await h.controller.disable();
  await h.controller.enable();
  release();
  await oldTick;

  assert.equal(h.vscode.configuration["codexAutoResume.enabled"], true);
  assert.equal(h.state(), undefined);
  assert.equal(h.context.workspaceState.get(PENDING_KEY), undefined);
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
  assert.equal(h.sends.length, 0);
});
