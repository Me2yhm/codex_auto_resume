import { RateLimitsReadResponse } from "./types";

export interface QuotaAvailability {
  status: "available" | "blocked" | "unknown";
  reason: string;
}

interface SnapshotEvidence {
  valid: boolean;
  windows: number;
  blocked: boolean;
}

/** Classify complete account reads; a failed read is represented by null. */
export function classifyQuotaAvailability(
  response: RateLimitsReadResponse | null | undefined,
): QuotaAvailability {
  if (!isRecord(response)) return unknown("unavailable-response");

  const permission = response.ordinaryUsageAllowed;
  // An explicit denial is sufficient to suppress requests even if the server
  // does not provide the corresponding quota windows.
  if (permission === false) return { status: "blocked", reason: "ordinary-usage-blocked" };
  if (permission !== undefined && permission !== null && permission !== true) {
    return unknown("invalid-ordinary-usage-flag");
  }

  if (!isRecord(response.rateLimits)) return unknown("missing-rate-limit-snapshot");
  const evidence = [inspectSnapshot(response.rateLimits)];
  const byId = response.rateLimitsByLimitId;
  if (byId !== undefined && byId !== null) {
    if (!isRecord(byId)) return unknown("malformed-rate-limits-by-id");
    evidence.push(...Object.values(byId).map(inspectSnapshot));
  }
  if (evidence.some((snapshot) => !snapshot.valid)) {
    return unknown("malformed-rate-limit-snapshot");
  }

  // Additional reported limits cannot be discarded merely because the main
  // snapshot or the ordinary-usage flag appears usable.
  if (evidence.some((snapshot) => snapshot.blocked)) {
    return permission === true
      ? unknown("contradictory-signals")
      : { status: "blocked", reason: "rate-limit-blocked" };
  }
  if (permission === true) return { status: "available", reason: "ordinary-usage-allowed" };
  if (permission === null) return unknown("ordinary-usage-unknown");

  // Older app-server releases omit the permission flag. Only complete,
  // explicitly reported windows can support their percentage-based fallback.
  return evidence.some((snapshot) => snapshot.windows > 0)
    ? { status: "available", reason: "legacy-windows-available" }
    : unknown("missing-quota-windows");
}

function inspectSnapshot(value: unknown): SnapshotEvidence {
  const evidence: SnapshotEvidence = { valid: true, windows: 0, blocked: false };
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "primary") ||
    !Object.hasOwn(value, "secondary") ||
    !Object.hasOwn(value, "rateLimitReachedType")
  ) {
    return { ...evidence, valid: false };
  }

  const reached = value.rateLimitReachedType;
  if (reached !== null) {
    if (typeof reached !== "string" || reached.trim().length === 0) {
      return { ...evidence, valid: false };
    }
    evidence.blocked = true;
  }

  for (const window of [value.primary, value.secondary]) {
    if (window === null) continue;
    if (
      !isRecord(window) ||
      !isFiniteNumber(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      !Object.hasOwn(window, "windowDurationMins") ||
      !Object.hasOwn(window, "resetsAt") ||
      !isNullablePositiveNumber(window.windowDurationMins) ||
      !(window.resetsAt === null || (isFiniteNumber(window.resetsAt) && window.resetsAt >= 0))
    ) {
      return { ...evidence, valid: false };
    }
    evidence.windows += 1;
    evidence.blocked ||= window.usedPercent >= 99;
  }
  return evidence;
}

function unknown(reason: string): QuotaAvailability {
  return { status: "unknown", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullablePositiveNumber(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value > 0);
}
