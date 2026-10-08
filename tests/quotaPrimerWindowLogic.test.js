const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyWindowMotion,
  windowLooksLikeDormantCandidate,
} = require("../dist/quotaPrimerWindowLogic.js");

test("classifies a resetAt that moves with wall clock as moving", () => {
  const previousObservedAtMs = 1_000_000;
  const previousResetAtMs = 20_000_000;
  const elapsedMs = 61_000;

  const result = classifyWindowMotion(
    previousObservedAtMs,
    previousResetAtMs,
    previousObservedAtMs + elapsedMs,
    previousResetAtMs + 62_000,
  );

  assert.equal(result.motion, "moving");
});

test("classifies a stable resetAt as fixed", () => {
  const previousObservedAtMs = 1_000_000;
  const previousResetAtMs = 20_000_000;

  const result = classifyWindowMotion(
    previousObservedAtMs,
    previousResetAtMs,
    previousObservedAtMs + 60_000,
    previousResetAtMs + 500,
  );

  assert.equal(result.motion, "fixed");
});

test("keeps ambiguous reset motion unknown", () => {
  const previousObservedAtMs = 1_000_000;
  const previousResetAtMs = 20_000_000;

  const result = classifyWindowMotion(
    previousObservedAtMs,
    previousResetAtMs,
    previousObservedAtMs + 60_000,
    previousResetAtMs + 30_000,
  );

  assert.equal(result.motion, "unknown");
});

test("requires enough elapsed time before classifying motion", () => {
  const result = classifyWindowMotion(
    1_000_000,
    20_000_000,
    1_010_000,
    20_010_000,
  );

  assert.equal(result.motion, "unknown");
});

test("recognizes an unused full-duration primary window as a dormant candidate", () => {
  const nowMs = 1_800_000_000_000;
  const durationMins = 300;
  const resetMs = nowMs + durationMins * 60_000;

  assert.equal(
    windowLooksLikeDormantCandidate(
      {
        usedPercent: 0,
        resetsAt: resetMs / 1000,
        windowDurationMins: durationMins,
      },
      nowMs,
    ),
    true,
  );
});

test("does not call a used window dormant", () => {
  const nowMs = 1_800_000_000_000;
  const durationMins = 300;
  const resetMs = nowMs + durationMins * 60_000;

  assert.equal(
    windowLooksLikeDormantCandidate(
      {
        usedPercent: 1,
        resetsAt: resetMs / 1000,
        windowDurationMins: durationMins,
      },
      nowMs,
    ),
    false,
  );
});
