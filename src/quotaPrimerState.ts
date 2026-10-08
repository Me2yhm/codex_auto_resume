export const QUOTA_PRIMER_STATE_KEY = "codexAutoResume.quotaPrimer.state";

export interface QuotaPrimerWindowState {
  trackedResetAtMs?: number;
  windowDurationMins?: number | null;
  lastHandledResetAtMs?: number;
}

export interface QuotaPrimerPendingConfirmation {
  primaryResetAtMs?: number;
  secondaryResetAtMs?: number;
  turnId?: string;
  sentAtMs: number;
}

export interface QuotaPrimerState {
  threadId?: string;
  model?: string;
  effort?: string;
  primary?: QuotaPrimerWindowState;
  secondary?: QuotaPrimerWindowState;
  pendingConfirmation?: QuotaPrimerPendingConfirmation;
  lastPrimeAtMs?: number;
}
