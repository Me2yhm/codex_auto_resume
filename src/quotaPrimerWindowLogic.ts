import type { RateLimitWindow } from "./types";

export const WINDOW_PROBE_MIN_ELAPSED_MS = 15_000;

export type WindowMotion = "moving" | "fixed" | "unknown";

export interface WindowProbeClassification {
  motion: WindowMotion;
  elapsedMs?: number;
  resetDeltaMs?: number;
}

export function classifyWindowMotion(
  previousObservedAtMs: number | undefined,
  previousResetAtMs: number | undefined,
  currentObservedAtMs: number,
  currentResetAtMs: number | undefined,
): WindowProbeClassification {
  if (
    previousObservedAtMs === undefined ||
    previousResetAtMs === undefined ||
    currentResetAtMs === undefined
  ) {
    return { motion: "unknown" };
  }

  const elapsedMs = currentObservedAtMs - previousObservedAtMs;
  if (elapsedMs < WINDOW_PROBE_MIN_ELAPSED_MS) {
    return { motion: "unknown", elapsedMs };
  }

  const resetDeltaMs = currentResetAtMs - previousResetAtMs;
  const toleranceMs = Math.max(
    1_500,
    Math.min(10_000, Math.round(elapsedMs * 0.25)),
  );

  if (Math.abs(resetDeltaMs) <= toleranceMs) {
    return { motion: "fixed", elapsedMs, resetDeltaMs };
  }

  if (Math.abs(resetDeltaMs - elapsedMs) <= toleranceMs) {
    return { motion: "moving", elapsedMs, resetDeltaMs };
  }

  return { motion: "unknown", elapsedMs, resetDeltaMs };
}

export function windowLooksLikeDormantCandidate(
  window: RateLimitWindow | null,
  nowMs: number,
): boolean {
  if (!window || typeof window.windowDurationMins !== "number") return false;
  if (window.usedPercent > 0) return false;

  const currentResetAtMs = resetAtMs(window);
  if (!currentResetAtMs) return false;

  const durationMs = window.windowDurationMins * 60_000;
  if (durationMs <= 0) return false;

  const remainingMs = currentResetAtMs - nowMs;
  const toleranceMs = Math.max(
    10_000,
    Math.min(90_000, Math.round(durationMs * 0.001)),
  );
  return Math.abs(remainingMs - durationMs) <= toleranceMs;
}

export function resetAtMs(window: RateLimitWindow | null): number | undefined {
  return typeof window?.resetsAt === "number"
    ? window.resetsAt * 1_000
    : undefined;
}
