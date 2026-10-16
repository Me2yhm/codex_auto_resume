const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyQuotaAvailability } = require("../dist/quotaAvailability.js");

function window(usedPercent = 10, changes = {}) {
  return { usedPercent, windowDurationMins: 300, resetsAt: 2_000_000_000, ...changes };
}

function snapshot(changes = {}) {
  return {
    limitId: "codex",
    limitName: "Codex",
    primary: window(),
    secondary: null,
    rateLimitReachedType: null,
    ...changes,
  };
}

function response(permission, changes = {}) {
  return { ordinaryUsageAllowed: permission, rateLimits: snapshot(), ...changes };
}

test("explicit ordinary-usage permission requires a complete snapshot without blockers", () => {
  assert.deepEqual(classifyQuotaAvailability(response(true)), {
    status: "available",
    reason: "ordinary-usage-allowed",
  });
  assert.equal(classifyQuotaAvailability(response(true, {
    rateLimits: snapshot({ primary: null, secondary: null }),
  })).status, "available");
});

test("ordinaryUsageAllowed=false blocks despite low percentages or absent windows", () => {
  assert.equal(classifyQuotaAvailability(response(false)).status, "blocked");
  assert.equal(classifyQuotaAvailability({ ordinaryUsageAllowed: false, rateLimits: null }).status, "blocked");
});

test("an explicit null permission never uses the legacy availability fallback", () => {
  assert.deepEqual(classifyQuotaAvailability(response(null)), {
    status: "unknown",
    reason: "ordinary-usage-unknown",
  });
});

test("legacy reads require at least one complete reported window and honor all windows", () => {
  const legacy = { rateLimits: snapshot() };
  assert.equal(classifyQuotaAvailability(legacy).status, "available");
  assert.equal(classifyQuotaAvailability({ rateLimits: snapshot({ primary: null, secondary: window(98.99) }) }).status, "available");
  assert.equal(classifyQuotaAvailability({ rateLimits: snapshot({ primary: null }) }).status, "unknown");
  assert.equal(classifyQuotaAvailability({ rateLimits: snapshot({ secondary: window(99) }) }).status, "blocked");
  assert.equal(classifyQuotaAvailability({ rateLimits: snapshot({ primary: window(10, { resetsAt: null, windowDurationMins: null }) }) }).status, "available");
});

for (const usedPercent of [99, 100]) {
  test(`${usedPercent}% blocks legacy reads and contradicts an explicit allow signal`, () => {
    const rateLimits = snapshot({ primary: window(usedPercent) });
    assert.equal(classifyQuotaAvailability({ rateLimits }).status, "blocked");
    assert.deepEqual(classifyQuotaAvailability(response(true, { rateLimits })), {
      status: "unknown",
      reason: "contradictory-signals",
    });
  });
}

test("nonempty rateLimitReachedType blocks and cannot be overridden by true", () => {
  for (const rateLimitReachedType of ["rate_limit_reached", "workspace_owner_credits_depleted", "future_server_blocker"]) {
    const rateLimits = snapshot({ rateLimitReachedType });
    assert.equal(classifyQuotaAvailability({ rateLimits }).status, "blocked");
    assert.deepEqual(classifyQuotaAvailability(response(true, { rateLimits })), {
      status: "unknown",
      reason: "contradictory-signals",
    });
  }
});

test("failed or absent API reads remain unknown, including a timeout represented as no response", async () => {
  let timeoutResponse;
  try {
    await Promise.reject(new Error("HTTP timeout / proxy connection unavailable"));
  } catch {
    timeoutResponse = null;
  }
  for (const value of [timeoutResponse, undefined, {}, [], "unavailable"]) {
    assert.equal(classifyQuotaAvailability(value).status, "unknown");
  }
});

test("true does not turn absent, incomplete, or malformed quota payloads into availability", () => {
  const missingPrimary = snapshot();
  delete missingPrimary.primary;
  const missingSecondary = snapshot();
  delete missingSecondary.secondary;
  const missingReachedType = snapshot();
  delete missingReachedType.rateLimitReachedType;
  const missingDuration = window();
  delete missingDuration.windowDurationMins;
  const missingReset = window();
  delete missingReset.resetsAt;
  const malformed = [
    null, undefined, {}, [],
    missingPrimary, missingSecondary, missingReachedType,
    snapshot({ primary: undefined }),
    snapshot({ primary: {} }),
    snapshot({ primary: missingDuration }),
    snapshot({ primary: missingReset }),
    snapshot({ primary: window(NaN) }),
    snapshot({ primary: window(Infinity) }),
    snapshot({ primary: window(-1) }),
    snapshot({ primary: window(101) }),
    snapshot({ primary: window("10") }),
    snapshot({ primary: window(10, { windowDurationMins: 0 }) }),
    snapshot({ primary: window(10, { windowDurationMins: Infinity }) }),
    snapshot({ primary: window(10, { resetsAt: -1 }) }),
    snapshot({ primary: window(10, { resetsAt: NaN }) }),
    snapshot({ secondary: window(NaN) }),
    snapshot({ rateLimitReachedType: undefined }),
    snapshot({ rateLimitReachedType: "" }),
    snapshot({ rateLimitReachedType: false }),
  ];
  for (const rateLimits of malformed) {
    assert.equal(classifyQuotaAvailability(response(true, { rateLimits })).status, "unknown");
  }
});

test("malformed ordinary-usage flags cannot invoke legacy availability", () => {
  for (const permission of [0, 1, "true", "false", {}, []]) {
    assert.equal(classifyQuotaAvailability(response(permission)).status, "unknown");
  }
});

test("all additional limit IDs contribute blocking or contradictory evidence", () => {
  for (const blocked of [snapshot({ primary: window(100) }), snapshot({ rateLimitReachedType: "rate_limit_reached" })]) {
    const changes = { rateLimitsByLimitId: { additionalModel: blocked } };
    assert.equal(classifyQuotaAvailability(response(undefined, changes)).status, "blocked");
    assert.deepEqual(classifyQuotaAvailability(response(true, changes)), {
      status: "unknown",
      reason: "contradictory-signals",
    });
  }
  assert.equal(classifyQuotaAvailability(response(true, {
    rateLimitsByLimitId: { additionalModel: snapshot({ primary: window(98) }) },
  })).status, "available");
});

test("malformed additional limits fail closed rather than being silently discarded", () => {
  for (const rateLimitsByLimitId of [false, [], { bad: null }, { bad: {} }, { bad: snapshot({ secondary: undefined }) }]) {
    assert.equal(classifyQuotaAvailability(response(true, { rateLimitsByLimitId })).status, "unknown");
  }
});

test("reset timestamp movement alone supplies no availability evidence", () => {
  const rateLimits = snapshot({ primary: window(100, { resetsAt: Date.now() / 1000 + 300 * 60 }) });
  assert.equal(classifyQuotaAvailability({ rateLimits }).status, "blocked");
});


test("modern spend-control denial is a hard blocker and conflicts with explicit ordinary permission", () => {
  for (const permission of [undefined, null, true]) {
    const response = { ordinaryUsageAllowed: permission, rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: null, rateLimitReachedType: null, spendControlReached: true,
    } };
    assert.equal(classifyQuotaAvailability(response).status, permission === true ? 'unknown' : 'blocked');
  }
});
