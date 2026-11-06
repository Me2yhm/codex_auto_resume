const assert = require("node:assert/strict");
const test = require("node:test");
const { createControllerHarness, createMemoryMemento } = require("./helpers/controllerHarness.js");
const {
  RECOVERY_BACKLOG_KEY, enqueueRecovery, readRecoveryBacklog,
  recoveryQueueSummary, selectNextRecovery,
} = require("../dist/recoveryQueue.js");

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const NOW = 1_900_000_000_000;
const ARMED_KEY = "codexAutoResume.armed";

function recovery(threadId, changes = {}) {
  return {
    threadId, cwd: "/workspace", armedAtMs: NOW - 60_000,
    resetAtMs: NOW + 3600_000, reason: "usageLimitExceeded",
    interruptedTurnId: `failed-${threadId}`,
    ...changes,
  };
}
function plan(action) {
  return { action, reason: action === "continue" ? "recorded_execution_after_input" : "user_only_input_requires_review",
    fingerprint: "sha256:test", inputs: [] };
}
function rateLimits(available = false) {
  return {
    ordinaryUsageAllowed: available,
    rateLimits: {
      primary: { usedPercent: available ? 1 : 100, resetsAt: NOW / 1000 + 3600, windowDurationMins: 300 },
      secondary: null, rateLimitReachedType: null,
    },
  };
}
function failedTurn(id) {
  return {
    id: `failed-${id}`, status: "failed", itemsView: "full", items: [],
    error: { codexErrorInfo: "usageLimitExceeded", message: "quota", additionalDetails: null },
    startedAt: null, completedAt: null,
  };
}
function attachWindowTabs(h, ids) {
  h.vscode.TabInputCustom = class {
    constructor(id) {
      this.viewType = "chatgpt.conversationEditor";
      this.uri = { scheme: "openai-codex", authority: "route", path: `/local/${id}` };
    }
  };
  h.vscode.window.tabGroups = { all: [{ tabs: ids.map(id => ({ input: new h.vscode.TabInputCustom(id) })) }] };
}
function harness(t, options = {}) {
  const shared = options.workspaceState ?? createMemoryMemento({
    [ARMED_KEY]: options.active ?? recovery(A, { recoveryPlan: plan("continue") }),
    ...(options.backlog ? { [RECOVERY_BACKLOG_KEY]: options.backlog } : {}),
  });
  const h = createControllerHarness({
    workspaceState: shared,
    request(method, params) {
      if (method === "account/rateLimits/read") return rateLimits(false);
      if (method === "thread/list") return { data: [A, B, C].map((id, i) => ({
        id, cwd: "/workspace", preview: "task", updatedAt: NOW / 1000 - i,
        recencyAt: null, source: "vscode", status: { type: "inactive" },
      })), nextCursor: null };
      if (method === "thread/turns/list") return { data: [failedTurn(params.threadId)], nextCursor: null };
      throw new Error("unexpected method " + method);
    },
  });
  attachWindowTabs(h, options.windowTabs ?? [A, B, C]);
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  t.after(() => h.dispose());
  return h;
}

test("backlog validates every persisted record, rejects duplicates and preserves FIFO", () => {
  const a = recovery(A), b = recovery(B);
  assert.deepEqual(readRecoveryBacklog(undefined), []);
  assert.throws(() => readRecoveryBacklog([{ threadId: B }]), /Invalid/);
  assert.throws(() => readRecoveryBacklog([a, a]), /duplicate/);
  assert.deepEqual(enqueueRecovery([a], a), [a]);
  assert.deepEqual(enqueueRecovery([a], b, B), [a]);
  assert.deepEqual(enqueueRecovery([a], b), [a, b]);
  assert.equal(selectNextRecovery([a, b], true).selected.threadId, A);
});

test("a review-blocked record is skipped, but a pending dispatch is never skipped", () => {
  const a = recovery(A, { recoveryPlan: plan("needs_review") });
  const b = recovery(B, { recoveryPlan: plan("continue") });
  assert.equal(selectNextRecovery([a, b], true).selected.threadId, B);
  assert.equal(selectNextRecovery([a], true), undefined);
  const pending = recovery(A, { ...a, dispatchPending: { beforeTurnId: "old", sentAtMs: NOW } });
  assert.equal(selectNextRecovery([pending, b], true).selected.threadId, A);
  assert.deepEqual(recoveryQueueSummary(a, [b]), { total: 2, requiresReview: 1, verifying: 0, ready: 1 });
});

test("one window discovers all its visible quota-failed conversations without replacing existing Armed", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = harness(t);
  await h.tick();
  const backlog = h.context.workspaceState.get(RECOVERY_BACKLOG_KEY);
  assert.deepEqual(backlog.map(item => item.threadId), [B, C]);
  assert.equal(h.context.workspaceState.get(ARMED_KEY).threadId, A);
  assert.ok(backlog.every(item => item.recoveryPlan));
  assert.equal(h.sends.length, 0);
  await h.tick();
  assert.deepEqual(h.context.workspaceState.get(RECOVERY_BACKLOG_KEY).map(item => item.threadId), [B, C]);
});

test("same workspace conversations from other windows are never automatically queued", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = harness(t, { windowTabs: [A, B] });
  await h.tick();
  assert.deepEqual(h.context.workspaceState.get(RECOVERY_BACKLOG_KEY).map(item => item.threadId), [B]);
  assert.equal(h.context.workspaceState.get(ARMED_KEY).threadId, A);
  assert.equal(h.sends.length, 0);
});

test("a reviewed-out active conversation yields to another ready saved conversation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = harness(t, {
    active: recovery(A, { recoveryPlan: plan("needs_review") }),
    backlog: [recovery(B, { recoveryPlan: plan("needs_review") }),
      recovery(C, { recoveryPlan: plan("continue") })],
  });
  await h.tick();
  assert.equal(h.context.workspaceState.get(ARMED_KEY).threadId, C);
  const backlog = h.context.workspaceState.get(RECOVERY_BACKLOG_KEY);
  assert.deepEqual(backlog.map(item => item.threadId), [B, A]);
  assert.equal(h.sends.length, 0);
});

test("a backlog survives controller recreation and restores the exact input decision", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const state = createMemoryMemento({
    [ARMED_KEY]: recovery(A, { recoveryPlan: plan("needs_review") }),
    [RECOVERY_BACKLOG_KEY]: [recovery(B, { recoveryPlan: plan("continue"), replayAttempts: 1 })],
  });
  const first = harness(t, { workspaceState: state, windowTabs: [A] });
  await first.tick();
  assert.equal(state.get(RECOVERY_BACKLOG_KEY)[0].replayAttempts, 1);
  first.dispose();
  const second = harness(t, { workspaceState: state, windowTabs: [A, B] });
  await second.tick();
  assert.equal(state.get(ARMED_KEY).threadId, B);
  assert.equal(state.get(ARMED_KEY).replayAttempts, 1);
  assert.equal(state.get(RECOVERY_BACKLOG_KEY)[0].threadId, A);
});

test("a corrupt backlog fails closed and does not send any continuation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const state = createMemoryMemento({ [RECOVERY_BACKLOG_KEY]: [{ threadId: B }] });
  const h = harness(t, { workspaceState: state });
  await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(state.get(RECOVERY_BACKLOG_KEY).length, 1);
  assert.ok(h.logs.some(line => line.includes("Invalid multi-session recovery")));
});
