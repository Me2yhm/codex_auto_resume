import type { ArmedResume } from "./types";

/** Backlog only: the active record remains in the legacy single-target slot. */
export const RECOVERY_BACKLOG_KEY = "codexAutoResume.recoveryBacklog.v1";
export const MAX_RECOVERY_BACKLOG = 64;

function isArmedResume(value: unknown): value is ArmedResume {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.threadId === "string" && item.threadId.length > 0 &&
    typeof item.cwd === "string" &&
    typeof item.armedAtMs === "number" && Number.isFinite(item.armedAtMs) &&
    typeof item.resetAtMs === "number" && Number.isFinite(item.resetAtMs) &&
    ["usageLimitExceeded", "rateLimitExceeded", "rateLimitReached"].includes(String(item.reason)) &&
    (item.interruptedTurnId === undefined || typeof item.interruptedTurnId === "string");
}

/** Invalid persisted data fails closed rather than silently losing saved input. */
export function readRecoveryBacklog(value: unknown): ArmedResume[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_BACKLOG) {
    throw new Error("Invalid multi-session recovery backlog; preserved for manual inspection");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isArmedResume(entry) || seen.has(entry.threadId)) {
      throw new Error("Invalid or duplicate multi-session recovery record; preserved for manual inspection");
    }
    seen.add(entry.threadId);
  }
  return value as ArmedResume[];
}

/** Never replace a queued input snapshot while an older record is unresolved. */
export function enqueueRecovery(
  backlog: ArmedResume[],
  record: ArmedResume,
  activeThreadId?: string,
): ArmedResume[] {
  if (record.threadId === activeThreadId || backlog.some(item => item.threadId === record.threadId)) {
    return backlog;
  }
  if (backlog.length >= MAX_RECOVERY_BACKLOG) return backlog;
  return [...backlog, record];
}

export function eligibleForAutoResume(entry: ArmedResume): boolean {
  return entry.recoveryPlan?.action !== "needs_review";
}

export function selectNextRecovery(
  backlog: ArmedResume[],
  skipReview: boolean,
): { selected: ArmedResume; remaining: ArmedResume[] } | undefined {
  // Uncertain dispatches must be reconciled before dispatching another entry.
  const pending = backlog.findIndex(item => item.dispatchPending || item.resumeTurnId);
  const index = pending >= 0 ? pending
    : backlog.findIndex(item => !skipReview || eligibleForAutoResume(item));
  if (index < 0) return undefined;
  return { selected: backlog[index], remaining: backlog.filter((_, i) => i !== index) };
}

export function recoveryQueueSummary(active: ArmedResume | undefined, backlog: ArmedResume[]): {
  total: number;
  requiresReview: number;
  verifying: number;
  ready: number;
} {
  const entries = [...(active ? [active] : []), ...backlog.filter(item => item.threadId !== active?.threadId)];
  return {
    total: entries.length,
    requiresReview: entries.filter(item => item.recoveryPlan?.action === "needs_review").length,
    verifying: entries.filter(item => item.dispatchPending || item.resumeTurnId).length,
    ready: entries.filter(item => eligibleForAutoResume(item) && !item.dispatchPending && !item.resumeTurnId).length,
  };
}
