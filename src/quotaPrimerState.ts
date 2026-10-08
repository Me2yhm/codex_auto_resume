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

export interface QuotaPrimerState {
  threadId?: string;
  threadCwd?: string;
  model?: string;
  effort?: string;
  primary?: QuotaPrimerWindowState;
  secondary?: QuotaPrimerWindowState;
  pendingConfirmation?: QuotaPrimerPendingConfirmation;
  lastPrimeAtMs?: number;
}
