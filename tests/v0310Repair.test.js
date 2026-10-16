const assert = require("node:assert/strict");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");

const NOW = 1_900_000_000_000;
const WORK = "guarded-work";
const TURN = "blocked-turn";
function mock(t) {
  t.mock.method(Date, "now", () => NOW);
  const original = { id: TURN, status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } };
  const turns = { current: original };
  const h = createControllerHarness({
    workspaceValues: { "codexAutoResume.armed": {
      threadId: WORK, cwd: "/workspace", armedAtMs: NOW - 1000,
      resetAtMs: NOW + 60_000, interruptedTurnId: TURN, reason: "usageLimitExceeded",
    } },
    request(method) {
      if (method === "account/rateLimits/read") return { ordinaryUsageAllowed: true, rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: (NOW + 60_000) / 1000 },
        secondary: null, rateLimitReachedType: null,
      } };
      if (method === "thread/turns/list") return { data: [turns.current], nextCursor: null };
      throw new Error(method);
    },
  });
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  t.after(h.dispose);
  return { ...h, turns, state: () => h.context.workspaceState.get("codexAutoResume.armed") };
}
test("Disable during owner discovery cancels the known-unsent work continuation", async (t) => {
  const h = mock(t);
  let attempted = 0;
  h.controller.sendThroughOfficialUi = async (_thread, _prompt, _prefix, guard) => {
    await h.controller.disable();
    await guard();
    attempted += 1;
    return true;
  };
  await h.controller.ensureClient();
  await h.controller.tryAutomaticResume(h.state());
  assert.equal(attempted, 0);
  assert.equal(h.state(), undefined);
  assert.ok(h.logs.some(line => line.includes("cancelled unsent continuation")));
});
test("manual continuation during owner discovery cancels stale automatic dispatch", async (t) => {
  const h = mock(t);
  let attempted = 0;
  h.controller.sendThroughOfficialUi = async (_thread, _prompt, _prefix, guard) => {
    h.turns.current = { id: "manual-turn", status: "inProgress", error: null };
    await guard();
    attempted += 1;
    return true;
  };
  await h.controller.tryAutomaticResume(h.state());
  assert.equal(attempted, 0);
  assert.equal(h.state().dispatchPending, undefined);
  assert.ok(h.logs.some(line => line.includes("cancelled unsent continuation")));
});
