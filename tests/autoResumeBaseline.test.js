const assert = require("node:assert/strict");
const test = require("node:test");

const { createControllerHarness } = require("./helpers/controllerHarness.js");

const ARMED_STATE_KEY = "codexAutoResume.armed";

test("0.3.9 regression: a tracked interrupted/null turn stays tracked until completion without resending", async (t) => {
  const now = Date.now();
  const armed = {
    threadId: "original-conversation",
    cwd: "/workspace",
    armedAtMs: now - 60_000,
    resetAtMs: now - 30_000,
    reason: "usageLimitExceeded",
    resumeTurnId: "accepted-resume-turn",
    resumeStartedAtMs: now - 20_000,
  };
  let turnStatus = "interrupted";
  const harness = createControllerHarness({
    workspaceValues: { [ARMED_STATE_KEY]: armed },
    request(method, params) {
      if (method === "account/rateLimits/read") {
        return {
          ordinaryUsageAllowed: true,
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (now + 60_000) / 1000 },
            secondary: null,
            rateLimitReachedType: null,
          },
        };
      }
      assert.equal(method, "thread/turns/list");
      assert.equal(params.threadId, armed.threadId);
      return {
        data: [{ id: armed.resumeTurnId, status: turnStatus, error: null, startedAt: null, completedAt: null }],
        nextCursor: null,
      };
    },
  });
  t.after(harness.dispose);

  await harness.tick();
  assert.deepEqual(harness.context.workspaceState.get(ARMED_STATE_KEY), armed);
  assert.match(harness.vscode.statusBars[0].text, /Verifying/);
  assert.equal(harness.sends.length, 0);

  // Repeated polls of the transient persisted state cannot start a second turn.
  await harness.tick();
  assert.equal(harness.context.workspaceState.get(ARMED_STATE_KEY).resumeTurnId, armed.resumeTurnId);
  assert.equal(harness.sends.length, 0);

  turnStatus = "completed";
  await harness.tick();
  assert.equal(harness.context.workspaceState.get(ARMED_STATE_KEY), undefined);
  assert.match(harness.vscode.statusBars[0].text, /Monitoring/);
  assert.equal(harness.sends.length, 0);
  assert.ok(harness.logs.some((line) => line.includes("completed; resumed and disarmed")));
});
