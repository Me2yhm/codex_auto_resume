export const QUOTA_PRIMER_STATE_KEY = "codexAutoResume.quotaPrimer.state";

export interface QuotaPrimerWindowState {
  trackedResetAtMs?: number;
  windowDurationMins?: number | null;
  lastHandledResetAtMs?: number;
  probeObservedAtMs?: number;
  probeResetAtMs?: number;
}

export interface QuotaPrimerPendingConfirmation {
  primaryResetAtMs?: number;
  secondaryResetAtMs?: number;
  primaryProbeObservedAtMs?: number;
  primaryProbeResetAtMs?: number;
  secondaryProbeObservedAtMs?: number;
  secondaryProbeResetAtMs?: number;
  turnId?: string;
  sentAtMs: number;
  stalledWarningLogged?: boolean;
}

export const MAX_KNOWN_PRIMER_THREAD_IDS = 256;

export interface QuotaPrimerState {
  knownPrimerThreadIds?: string[];
  threadId?: string;
  threadCwd?: string;
  model?: string;
  effort?: string;
  primary?: QuotaPrimerWindowState;
  secondary?: QuotaPrimerWindowState;
  pendingConfirmation?: QuotaPrimerPendingConfirmation;
  lastPrimeAtMs?: number;
}

/** Upgrade the 0.3.9 state without losing window, thread, or pending data. */
export function migrateQuotaPrimerState(state: QuotaPrimerState = {}): QuotaPrimerState {
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
  const known = Array.isArray(state.knownPrimerThreadIds) ? state.knownPrimerThreadIds : [];
  const ids = [...known, state.threadId].filter((id): id is string => typeof id === "string" && id.length > 0);
  // Keep the most recently remembered identities when trimming the bounded list.
  const unique = [...new Set(ids.reverse())].reverse().slice(-MAX_KNOWN_PRIMER_THREAD_IDS);
  return { ...state, knownPrimerThreadIds: unique };
}
