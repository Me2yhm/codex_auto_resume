export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType: RateLimitReachedType | null;
  spendControlReached?: boolean | null;
}

export interface RateLimitsReadResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "rateLimitExceeded"
  | "serverOverloaded"
  | "unauthorized"
  | "badRequest"
  | "sandboxError"
  | "internalServerError"
  | "other"
  | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

export interface CodexTurn {
  id: string;
  status: string;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CodexThread {
  id: string;
  preview: string;
  cwd: string;
  name?: string | null;
  originator?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  threadSource?: string | null;
  updatedAt: number;
  recencyAt: number | null;
  source: unknown;
  status: { type: string };
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
}

export interface ThreadTurnsListResponse {
  data: CodexTurn[];
  nextCursor: string | null;
}

export interface ArmedResume {
  threadId: string;
  cwd: string;
  armedAtMs: number;
  resetAtMs: number;
  reason: "usageLimitExceeded" | "rateLimitExceeded" | "rateLimitReached";
  interruptedTurnId?: string;
  dispatchPending?: {
    beforeTurnId?: string;
    sentAtMs: number;
  };
  resumeInProgressSinceMs?: number;
  // Set only after a continuation has been accepted by the official Codex UI
  // owner. Keeping this state persisted prevents duplicate continuation prompts
  // if VS Code restarts while the resumed turn is still being classified.
  resumeTurnId?: string;
  resumeStartedAtMs?: number;
}

export interface PendingQuotaInterruption {
  threadId: string;
  cwd: string;
  turnId: string;
  observedAtMs: number;
  reason?: ArmedResume["reason"];
}
