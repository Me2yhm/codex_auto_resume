const assert = require("node:assert/strict");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");

const ARMED_KEY = "codexAutoResume.armed";
const PENDING_KEY = "codexAutoResume.pendingQuotaCandidate";
const NOW = 1_900_000_000_000;
const THREAD_ID = "original-work-conversation";
const ORIGINAL_TURN_ID = "quota-interrupted-work-turn";
const PROMPT = "Continue the existing work from its interruption.";

function quota(ordinaryUsageAllowed = true, usedPercent = 1) {
  return {
    ordinaryUsageAllowed,
    rateLimits: {
      primary: { usedPercent, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
      secondary: null,
      rateLimitReachedType: null,
    },
  };
}

function turn(id = ORIGINAL_TURN_ID, status = "interrupted", error = null) {
  return { id, status, error, startedAt: null, completedAt: null };
}

function armed(changes = {}) {
  return {
    threadId: THREAD_ID,
    cwd: "/workspace",
    armedAtMs: NOW - 60_000,
    resetAtMs: NOW + 3_600_000,
    reason: "usageLimitExceeded",
    interruptedTurnId: ORIGINAL_TURN_ID,
    ...changes,
  };
}

function avoidRealObservationDelays(harness) {
  harness.controller.waitForNewTurn = async () => undefined;
  harness.controller.observeTrackedResumeAttempt = async () => {};
  return harness;
}

function setup(t, options = {}) {
  const clock = { now: NOW };
  t.mock.method(Date, "now", () => clock.now);
  let currentQuota = options.quota ?? quota();
  let turns = options.turns ?? [turn()];
  const requests = async (method, params) => {
    if (method === "account/rateLimits/read") {
      if (currentQuota instanceof Error) throw currentQuota;
      return currentQuota;
    }
    if (method === "thread/turns/list") {
      assert.equal(params.threadId, THREAD_ID);
      return { data: turns, nextCursor: null };
    }
    assert.equal(method, "thread/list");
    return {
      data: [{
        id: THREAD_ID,
        cwd: "/workspace",
        preview: "Real work",
        updatedAt: Math.floor(clock.now / 1000),
        recencyAt: null,
        source: "vscode",
        status: { type: "inactive" },
      }],
      nextCursor: null,
    };
  };
  const harness = avoidRealObservationDelays(createControllerHarness({
    workspaceValues: {
      ...(options.initialArmed === false ? {} : { [ARMED_KEY]: armed(options.armed) }),
      ...(options.pending ? { [PENDING_KEY]: options.pending } : {}),
    },
    configuration: { "codexAutoResume.resumePrompt": PROMPT },
    request: requests,
    send: options.send,
  }));
  t.after(harness.dispose);
  return Object.assign(harness, {
    clock,
    requestHandler: requests,
    advance(ms) { clock.now += ms; },
    setQuota(value) { currentQuota = value; },
    setTurns(value) { turns = value; },
    state: () => harness.context.workspaceState.get(ARMED_KEY),
    pending: () => harness.context.workspaceState.get(PENDING_KEY),
  });
}

test("a structured quota interruption arms the exact work turn without sending", async (t) => {
  const h = setup(t, {
    initialArmed: false,
    quota: quota(false, 100),
    turns: [turn(ORIGINAL_TURN_ID, "failed", { codexErrorInfo: "usageLimitExceeded", message: "Quota exhausted", additionalDetails: null })],
  });
  await h.tick();
  assert.equal(h.state().threadId, THREAD_ID);
  assert.equal(h.state().interruptedTurnId, ORIGINAL_TURN_ID);
  assert.equal(h.state().reason, "usageLimitExceeded");
  assert.equal(h.sends.length, 0);
});

for (const [label, resetAtMs] of [["early recovery before the old reset", NOW + 3_600_000], ["normal recovery after the old reset", NOW - 120_000]]) {
  test(`${label} requires independent available reads separated by ten seconds`, async (t) => {
    const h = setup(t, { armed: { resetAtMs } });
    let persistedBeforeSend = false;
    h.controller.sendThroughOfficialUi = async (threadId, prompt, prefix) => {
      persistedBeforeSend = Boolean(h.state().dispatchPending);
      assert.equal(h.state().dispatchPending.beforeTurnId, ORIGINAL_TURN_ID);
      assert.equal(threadId, THREAD_ID);
      assert.equal(prompt, PROMPT);
      assert.equal(prefix, "auto-resume");
      h.sends.push({ threadId, prompt, prefix });
      return true;
    };

    await h.tick();
    assert.equal(h.sends.length, 0);
    h.advance(9_999);
    await h.tick();
    assert.equal(h.sends.length, 0);
    h.advance(1);
    await h.tick();
    assert.equal(h.sends.length, 1);
    assert.equal(persistedBeforeSend, true);
    assert.ok(h.state().dispatchPending);
    assert.equal(h.state().threadId, THREAD_ID);
    assert.equal(h.state().resetAtMs, resetAtMs);
    assert.equal(h.requests.filter((request) => request.method === "thread/start").length, 0);
  });
}

for (const [label, unavailable] of [["blocked", quota(false, 100)], ["unknown", quota(null)], ["contradictory", quota(true, 100)], ["HTTP timeout", new Error("HTTP timeout")]]) {
  test(`a second ${label} read cancels availability confirmation and preserves the target`, async (t) => {
    const h = setup(t);
    await h.tick();
    h.advance(10_000);
    h.setQuota(unavailable);
    await h.tick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.state().threadId, THREAD_ID);

    h.setQuota(quota());
    h.advance(10_000);
    await h.tick();
    assert.equal(h.sends.length, 0, "recovery needs a new first available observation");
    h.advance(10_000);
    await h.tick();
    assert.equal(h.sends.length, 1);
  });
}

test("an expired availability observation cannot confirm a much later snapshot", async (t) => {
  const h = setup(t);
  await h.tick();
  h.advance(30_001);
  await h.tick();
  assert.equal(h.sends.length, 0);
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
});

test("quota endpoint failure preserves an armed conversation until two later valid reads", async (t) => {
  const h = setup(t, { quota: new Error("Remote proxy temporarily unavailable") });
  await h.tick();
  assert.equal(h.state().threadId, THREAD_ID);
  assert.equal(h.state().interruptedTurnId, ORIGINAL_TURN_ID);
  assert.equal(h.sends.length, 0);
  h.setQuota(quota());
  h.advance(60_000);
  await h.tick();
  assert.equal(h.sends.length, 0);
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].threadId, THREAD_ID);
});

test("a known no-owner result clears dispatch uncertainty and retries only after fresh confirmation", async (t) => {
  const h = setup(t, { send: async () => false });
  await h.tick();
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.state().dispatchPending, undefined);
  assert.equal(h.state().threadId, THREAD_ID);

  await h.tick();
  assert.equal(h.sends.length, 1);
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 2);
});

test("an ambiguous UI transport exception keeps a persisted dispatch record and never blindly resends", async (t) => {
  const h = setup(t, { send: async () => { throw new Error("UI acknowledgement lost"); } });
  await h.tick();
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.state().dispatchPending.beforeTurnId, ORIGINAL_TURN_ID);
  const sentAtMs = h.state().dispatchPending.sentAtMs;
  for (let poll = 0; poll < 3; poll += 1) {
    h.advance(120_000);
    await h.tick();
    assert.equal(h.sends.length, 1);
    assert.equal(h.state().dispatchPending.sentAtMs, sentAtMs);
  }
});

test("an accepted turn discovered after restart is tracked on the original conversation without another send", async (t) => {
  const h = setup(t);
  await h.tick();
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
  assert.ok(h.state().dispatchPending);
  h.dispose();

  const restarted = avoidRealObservationDelays(createControllerHarness({
    workspaceState: h.context.workspaceState,
    request: h.requestHandler,
  }));
  t.after(restarted.dispose);
  h.advance(60_000);
  await restarted.tick();
  assert.equal(restarted.sends.length, 0);
  assert.ok(h.state().dispatchPending);

  h.setTurns([turn("delayed-resume-turn"), turn()]);
  await restarted.tick();
  assert.equal(h.state().resumeTurnId, "delayed-resume-turn");
  assert.equal(h.state().dispatchPending, undefined);
  assert.equal(restarted.sends.length, 0);
  h.advance(60_000);
  await restarted.tick();
  assert.equal(h.state().resumeTurnId, "delayed-resume-turn");
  assert.equal(restarted.sends.length, 0);

  h.setTurns([turn("delayed-resume-turn", "completed"), turn()]);
  await restarted.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.sends.length + restarted.sends.length, 1);
});

test("an explicitly quota-failed pending turn with already available quota still requires confirmation", async (t) => {
  const h = setup(t, {
    initialArmed: false,
    pending: { threadId: THREAD_ID, cwd: "/workspace", turnId: ORIGINAL_TURN_ID, observedAtMs: NOW - 60_000, reason: "usageLimitExceeded" },
    turns: [turn(ORIGINAL_TURN_ID, "failed", { codexErrorInfo: "usageLimitExceeded", message: "Quota exhausted", additionalDetails: null })],
  });
  await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.state().interruptedTurnId, ORIGINAL_TURN_ID);
  assert.equal(h.pending(), undefined);
  h.advance(10_000);
  await h.tick();
  assert.equal(h.sends.length, 1);
});

test("a manual Stop observed while quota is unknown cannot be promoted when quota later becomes available", async (t) => {
  const h = setup(t, { initialArmed: false, quota: new Error("quota endpoint offline") });
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.pending().turnId, ORIGINAL_TURN_ID);
  assert.equal(h.pending().reason, undefined);

  h.setQuota(quota());
  await h.tick();
  assert.equal(h.pending(), undefined);
  h.advance(60_000);
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.sends.length, 0);
});

for (const gap of ["interrupted", "missing"]) {
  test(`stable inProgress confirmation restarts after a ${gap} observation`, async (t) => {
    const resumeId = "accepted-resume-turn";
    const h = setup(t, {
      armed: { resumeTurnId: resumeId, resumeStartedAtMs: NOW - 60_000 },
      turns: [turn(resumeId, "inProgress")],
    });
    await h.tick();
    assert.equal(h.state().resumeTurnId, resumeId, "an old submission timestamp does not prove continuous progress");
    h.advance(14_000);
    h.setTurns(gap === "missing" ? [] : [turn(resumeId)]);
    await h.tick();
    assert.equal(h.state().resumeInProgressSinceMs, undefined);

    h.advance(1_000);
    h.setTurns([turn(resumeId, "inProgress")]);
    await h.tick();
    assert.equal(h.state().resumeTurnId, resumeId);
    h.advance(14_000);
    await h.tick();
    assert.equal(h.state().resumeTurnId, resumeId);
    h.advance(1_000);
    await h.tick();
    assert.equal(h.state(), undefined);
    assert.equal(h.sends.length, 0);
  });
}

test("a tracked non-quota failure stays tracked and never sends another continuation", async (t) => {
  const resumeId = "accepted-resume-turn";
  const h = setup(t, {
    armed: { resumeTurnId: resumeId, resumeStartedAtMs: NOW - 60_000 },
    turns: [turn(resumeId, "failed", { codexErrorInfo: "internalServerError", message: "Backend failure", additionalDetails: null })],
  });
  await h.tick();
  h.advance(60_000);
  await h.tick();
  assert.equal(h.state().resumeTurnId, resumeId);
  assert.equal(h.sends.length, 0);
});

test("disabling during availability confirmation clears the target and prevents the pending send", async (t) => {
  const h = setup(t);
  await h.tick();
  await h.controller.disable();
  h.advance(10_000);
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.sends.length, 0);
});

for (const status of ["completed", "inProgress"]) {
  test(`a migrated armed record cannot continue a work turn that is already ${status}`, async (t) => {
    const h = setup(t, {
      armed: { interruptedTurnId: undefined },
      turns: [turn(ORIGINAL_TURN_ID, status)],
    });
    await h.tick();
    h.advance(10_000);
    await h.tick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.state()?.dispatchPending, undefined);
  });
}

for (const pausedMethod of ["thread/list", "thread/turns/list"]) {
  test(`Disable while awaiting ${pausedMethod} prevents an in-flight observation from rearming`, async (t) => {
    const h = setup(t, {
      initialArmed: false,
      quota: quota(false, 100),
      turns: [turn(ORIGINAL_TURN_ID, "failed", { codexErrorInfo: "usageLimitExceeded", message: "Quota exhausted", additionalDetails: null })],
    });
    let entered;
    let release;
    const observed = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    let paused = false;
    h.setRequestHandler(async (method, params) => {
      if (method === pausedMethod && !paused) {
        paused = true;
        entered();
        await barrier;
      }
      return h.requestHandler(method, params);
    });

    const runningTick = h.tick();
    await observed;
    await h.controller.disable();
    release();
    await runningTick;
    assert.equal(h.state(), undefined);
    assert.equal(h.pending(), undefined);
    assert.equal(h.sends.length, 0);
  });
}

test("a pending unstructured interruption survives a successful but malformed account read", async (t) => {
  const h = setup(t, { initialArmed: false, quota: new Error("quota endpoint offline") });
  await h.tick();
  const originalCandidate = h.pending();
  assert.equal(originalCandidate.turnId, ORIGINAL_TURN_ID);
  h.setQuota({ ordinaryUsageAllowed: true, rateLimits: {} });
  h.advance(60_000);
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.deepEqual(h.pending(), originalCandidate);
  assert.equal(h.sends.length, 0);
});

test("an older completed turn cannot satisfy a persisted dispatch whose baseline is temporarily absent", async (t) => {
  const h = setup(t, {
    armed: { dispatchPending: { beforeTurnId: ORIGINAL_TURN_ID, sentAtMs: NOW - 10_000 } },
    turns: [{ ...turn("older-completed-turn", "completed"), startedAt: (NOW - 120_000) / 1000 }],
  });
  await h.tick();
  h.advance(60_000);
  await h.tick();
  assert.ok(h.state().dispatchPending);
  assert.equal(h.state().resumeTurnId, undefined);
  assert.equal(h.sends.length, 0);
});

for (const [unit, startedAt] of [["seconds", NOW / 1000], ["milliseconds", NOW]]) {
  test(`a delayed turn with a post-dispatch timestamp in ${unit} can be tracked when the baseline is absent`, async (t) => {
    const h = setup(t, {
      armed: { dispatchPending: { beforeTurnId: ORIGINAL_TURN_ID, sentAtMs: NOW - 1_500 } },
      turns: [{ ...turn("newly-started-turn"), startedAt }],
    });
    await h.tick();
    assert.equal(h.state().resumeTurnId, "newly-started-turn");
    assert.equal(h.state().dispatchPending, undefined);
    assert.equal(h.sends.length, 0);
  });
}
