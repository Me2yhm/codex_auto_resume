const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");

const ARMED_KEY = "codexAutoResume.armed";
const PENDING_KEY = "codexAutoResume.pendingQuotaCandidate";
const NOW = 1_900_000_000_000;
const THREAD_ID = "review-original-work";
const TURN_ID = "review-original-interruption";

function quota(allowed) {
  return {
    ordinaryUsageAllowed: allowed,
    rateLimits: {
      primary: { usedPercent: allowed ? 1 : 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 3_600 },
      secondary: null,
      rateLimitReachedType: null,
    },
  };
}

function turn(id = TURN_ID, status = "interrupted", codexErrorInfo) {
  return {
    id, status,
    error: codexErrorInfo ? { codexErrorInfo, message: "Quota exhausted", additionalDetails: null } : null,
    startedAt: null,
    completedAt: null,
  };
}

function armed() {
  return {
    threadId: THREAD_ID,
    cwd: "/workspace",
    armedAtMs: NOW - 60_000,
    resetAtMs: NOW + 3_600_000,
    reason: "usageLimitExceeded",
    interruptedTurnId: TURN_ID,
  };
}

function harness(t, options = {}) {
  let response = options.quota ?? quota(false);
  let turns = [turn()];
  const h = createControllerHarness({
    realCoordination: options.realCoordination,
    globalStoragePath: options.globalStoragePath,
    workspaceValues: options.armed ? { [ARMED_KEY]: armed() } : {},
    request(method, params) {
      if (method === "account/rateLimits/read") {
        if (response instanceof Error) throw response;
        return response;
      }
      if (method === "thread/turns/list") {
        assert.equal(params.threadId, THREAD_ID);
        return { data: turns, nextCursor: null };
      }
      assert.equal(method, "thread/list");
      return {
        data: [{ id: THREAD_ID, cwd: "/workspace", preview: "Real work", updatedAt: Date.now() / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" } }],
        nextCursor: null,
      };
    },
  });
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  t.after(h.dispose);
  return Object.assign(h, {
    setQuota(value) { response = value; },
    setTurns(value) { turns = value; },
    state: () => h.context.workspaceState.get(ARMED_KEY),
    pending: () => h.context.workspaceState.get(PENDING_KEY),
  });
}

for (const initialUnknown of [false, true]) {
  test(`manual Stop stays unarmed through ${initialUnknown ? "unknown then " : ""}blocked quota and subsequent availability`, async (t) => {
    let now = NOW;
    t.mock.method(Date, "now", () => now);
    const h = harness(t, { quota: initialUnknown ? new Error("quota endpoint unavailable") : quota(false) });
    await h.tick();
    assert.equal(h.state(), undefined);
    assert.equal(h.sends.length, 0);

    h.setQuota(quota(false));
    now += 60_000;
    await h.tick();
    assert.equal(h.state(), undefined, "an account blocker does not prove why the work turn stopped");
    assert.equal(h.pending()?.reason, undefined);

    h.setQuota(quota(true));
    for (const elapsed of [60_000, 10_000]) {
      now += elapsed;
      await h.tick();
      assert.equal(h.state(), undefined);
      assert.equal(h.sends.length, 0);
    }
    assert.equal(h.pending(), undefined);
  });
}

test("a later structured quota error updates the same pending interruption before confirmed recovery", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const h = harness(t, { quota: new Error("quota endpoint unavailable") });
  await h.tick();
  const pending = h.pending();
  assert.equal(pending.turnId, TURN_ID);
  assert.equal(pending.reason, undefined);

  h.setQuota(quota(false));
  now += 60_000;
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.pending().turnId, TURN_ID);
  assert.equal(h.pending().reason, undefined);

  h.setQuota(new Error("quota endpoint unavailable again"));
  h.setTurns([turn(TURN_ID, "failed", "usageLimitExceeded")]);
  now += 60_000;
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.pending().turnId, TURN_ID);
  assert.equal(h.pending().reason, "usageLimitExceeded");
  assert.equal(h.sends.length, 0);

  h.setQuota(quota(false));
  await h.tick();
  assert.equal(h.state().interruptedTurnId, TURN_ID);
  assert.equal(h.state().reason, "usageLimitExceeded");
  assert.equal(h.pending(), undefined);

  h.setQuota(quota(true));
  await h.tick();
  assert.equal(h.sends.length, 0);
  now += 10_000;
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].threadId, THREAD_ID);
});

test("two same-host windows with independent caches send only one continuation and observe its shared dispatch", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-work-review-dispatch-"));
  const windows = [];
  t.after(async () => {
    for (const h of windows) {
      await h.controller.recovery.clear().catch(() => {});
      h.dispose();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = { armed: true, quota: quota(true), realCoordination: true, globalStoragePath: root };
  windows.push(harness(t, options), harness(t, options));
  const [first, second] = windows;
  assert.notEqual(first.context.workspaceState, second.context.workspaceState);
  assert.notEqual(first.state(), second.state());

  await Promise.all(windows.map((h) => h.tick()));
  assert.equal(windows.reduce((count, h) => count + h.sends.length, 0), 0);
  now += 10_000;
  await Promise.all(windows.map((h) => h.tick()));
  assert.equal(windows.reduce((count, h) => count + h.sends.length, 0), 1);
  // A competing reader can see the exclusive file before its creator finishes
  // writing. It must remain armed and adopt that claim on a fresh confirmation.
  for (let poll = 0; poll < 3 && windows.some((h) => !h.state().dispatchPending); poll += 1) {
    now += 10_000;
    await Promise.all(windows.map((h) => h.tick()));
    assert.equal(windows.reduce((count, h) => count + h.sends.length, 0), 1);
  }
  assert.equal(first.state().dispatchPending.beforeTurnId, TURN_ID);
  assert.deepEqual(first.state().dispatchPending, second.state().dispatchPending);

  now += 60_000;
  await Promise.all(windows.map((h) => h.tick()));
  assert.equal(windows.reduce((count, h) => count + h.sends.length, 0), 1);
  for (const h of windows) h.setTurns([turn("shared-owner-resume"), turn()]);
  await Promise.all(windows.map((h) => h.tick()));
  for (const h of windows) {
    assert.equal(h.state().resumeTurnId, "shared-owner-resume");
    assert.equal(h.state().dispatchPending, undefined);
  }
  assert.equal(windows.reduce((count, h) => count + h.sends.length, 0), 1);
});

test("a corrupt Primer priority registry does not block independent work dispatch coordination", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-work-corrupt-priority-"));
  await fs.writeFile(path.join(root, "recovery-coordination"), "not a directory");
  const h = harness(t, { armed: true, quota: quota(true), realCoordination: true, globalStoragePath: root });
  t.after(async () => {
    h.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  await h.tick();
  assert.equal(h.sends.length, 0);
  now += 10_000;
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].threadId, THREAD_ID);
  assert.equal(h.state().dispatchPending.beforeTurnId, TURN_ID);
  assert.ok(h.logs.some((line) => line.includes("registration unavailable")));
});
