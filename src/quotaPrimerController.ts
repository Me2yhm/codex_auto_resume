import * as os from "os";
import * as vscode from "vscode";
import { classifyQuotaAvailability } from "./quotaAvailability";
import { PRIMER_THREAD_SOURCE } from "./primerIdentity";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import { tryAcquireQuotaPrimerSendLock } from "./quotaPrimerLock";
import { readRecoveryPriority } from "./recoveryCoordination";
import {
  QuotaPrimerJournalPending,
  QuotaPrimerSendJournal,
  readQuotaPrimerSendJournal,
  writeQuotaPrimerSendJournal,
} from "./quotaPrimerSendJournal";
import {
  sendTurnThroughOfficialCodexUi,
  trySendTurnThroughExistingOfficialOwner,
} from "./officialCodexUi";
import {
  QUOTA_PRIMER_STATE_KEY,
  migrateQuotaPrimerState,
  QuotaPrimerPendingConfirmation,
  QuotaPrimerState,
  QuotaPrimerWindowState,
} from "./quotaPrimerState";
import {
  classifyWindowMotion,
  resetAtMs,
  WindowMotion,
  WindowProbeClassification,
  windowLooksLikeDormantCandidate,
  WINDOW_PROBE_MIN_ELAPSED_MS,
} from "./quotaPrimerWindowLogic";
import {
  CodexThread,
  CodexTurn,
  RateLimitSnapshot,
  RateLimitWindow,
  RateLimitsReadResponse,
  ThreadListResponse,
  ThreadTurnsListResponse,
} from "./types";

const PRIMER_THREAD_NAME = "Codex Auto Resume - Quota Primer";
const RESET_JITTER_TOLERANCE_MS = 5_000;
const WINDOW_PROBE_RETRY_MS = 120_000;
const UI_PRIMER_STABILITY_MS = 15_000;
const UI_PRIMER_CONFIRMATION_POLLS = 120;

interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
}

interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

interface ThreadStartResponse {
  thread: CodexThread;
  model: string;
  reasoningEffort?: string | null;
}

interface TurnStartResponse {
  turn: CodexTurn;
}

interface PrimerModelChoice {
  model: string;
  displayName: string;
  effort?: string;
  fallback: boolean;
}

interface DueWindows {
  primary?: number;
  secondary?: number;
}

interface PrimerDispatchHooks {
  beforeDispatch(threadId: string, beforeTurnId?: string): Promise<void>;
  accepted(turnId?: string): Promise<void>;
  rejected(): Promise<void>;
}

class PrimerSuppressed extends Error {}

export class QuotaPrimerController implements vscode.Disposable {
  private client?: CodexRpcClient;
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private lifecycle = 0;
  private lastSuppression?: string;
  private lastObservation?: string;
  private quotaResponse?: RateLimitsReadResponse;
  private waitingReason?: string;
  private statusBar: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    this.statusBar.command = "codexAutoResume.quotaPrimer.status";
    this.statusBar.show();
    this.renderStatus();
  }

  async start(): Promise<void> {
    if (!this.enabled()) {
      this.renderStatus();
      return;
    }
    await this.tick();
  }

  async enable(): Promise<void> {
    await vscode.workspace
      .getConfiguration("codexAutoResume")
      .update("quotaPrimer.enabled", true, vscode.ConfigurationTarget.Global);
    await this.start();
    void vscode.window.showInformationMessage(
      "Codex Quota Primer enabled on this extension host. Keep it enabled on only one machine/remote host for the same Codex account.",
    );
  }

  async disable(): Promise<void> {
    this.lifecycle += 1;
    await vscode.workspace
      .getConfiguration("codexAutoResume")
      .update("quotaPrimer.enabled", false, vscode.ConfigurationTarget.Global);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.renderStatus();
    void vscode.window.showInformationMessage(
      "Codex Quota Primer disabled. The dedicated primer thread is kept for future reuse.",
    );
  }

  async showStatus(): Promise<void> {
    const state = this.state();
    if (!this.enabled()) {
      void vscode.window.showInformationMessage(
        `Codex Quota Primer is disabled. Prime Quota Now is a manual smoke test and does not enable automatic priming.${state.threadId ? ` Dedicated thread: ${state.threadId}${state.threadCwd ? ` (workspace: ${state.threadCwd})` : ""}.` : ""}`,
      );
      return;
    }

    const primary = formatTrackedWindow("primary", state.primary);
    const secondary = formatTrackedWindow("secondary", state.secondary);
    const pending = state.pendingConfirmation
      ? ` Waiting for reset-window confirmation after turn ${state.pendingConfirmation.turnId ?? "<unknown>"}.`
      : "";

    void vscode.window.showInformationMessage(
      `Codex Quota Primer is enabled. Thread: ${state.threadId ?? "<not created yet>"}${state.threadCwd ? ` (workspace: ${state.threadCwd})` : ""}. Model: ${state.model ?? "<not selected yet>"}${state.effort ? ` / ${state.effort}` : ""}. ${primary}; ${secondary}.${pending}`,
    );
  }

  async primeNow(): Promise<void> {
    await this.runPrimer(true);
  }

  async resetPrimerThread(): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage("Quota Primer is checking or confirming a turn. Retry Reset Quota Primer Thread after this check finishes.");
      return;
    }
    const lock = await tryAcquireQuotaPrimerSendLock(this.context.globalStorageUri.fsPath, this.output);
    if (!lock) return;
    try {
      const state = this.state();
      const journal = await this.readJournal();
      if (journal.updatedAtMs === 0 && state.pendingConfirmation && !state.threadId) {
        throw new Error("Legacy pending Primer has no thread identity");
      }
      const pending = journal.updatedAtMs === 0 && state.pendingConfirmation && state.threadId
        ? { ...state.pendingConfirmation, threadId: state.threadId } : journal.pending;
      const history = migrateQuotaPrimerState({
        ...state,
        knownPrimerThreadIds: [...(state.knownPrimerThreadIds ?? []), ...(journal.knownPrimerThreadIds ?? []),
          ...(journal.threadId ? [journal.threadId] : []), ...(journal.pending ? [journal.pending.threadId] : [])],
      }).knownPrimerThreadIds;
      await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, {
        ...journal, threadId: undefined, knownPrimerThreadIds: history, pending,
      });
      await this.saveState({
        ...state, threadId: undefined, knownPrimerThreadIds: history, threadCwd: undefined,
        model: undefined, effort: undefined, pendingConfirmation: pending,
      });
      void vscode.window.showInformationMessage(
        "Quota Primer reset its reuse target. Historical Primer conversations remain excluded from work recovery; an unconfirmed send remains tracked.",
      );
    } catch {
      void vscode.window.showWarningMessage("Quota Primer could not safely reset its shared state. Check the extension output and try again.");
    } finally { await lock.release(); }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycle += 1;
    if (this.timer) clearTimeout(this.timer);
    this.client?.dispose();
    this.statusBar.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<boolean>("quotaPrimer.enabled", false);
  }

  private state(): QuotaPrimerState {
    return migrateQuotaPrimerState(this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY));
  }

  private async saveState(state: QuotaPrimerState): Promise<void> {
    const previous = this.state();
    const migrated = migrateQuotaPrimerState({ ...state,
      knownPrimerThreadIds: [...(previous.knownPrimerThreadIds ?? []), ...(state.knownPrimerThreadIds ?? [])],
    });
    await this.context.globalState.update(QUOTA_PRIMER_STATE_KEY, migrated);
  }

  private async ensureClient(): Promise<void> {
    if (this.client?.isRunning) return;
    this.client?.dispose();
    this.client = new CodexRpcClient(resolveCodexExecutable(this.output), this.output);
    this.client.on("error", (error: Error) => this.output.appendLine(`[quota-primer][rpc] ${error.message}`));
    this.client.on("close", () => this.output.appendLine("[quota-primer][rpc] Codex app-server disconnected"));
    await this.client.start();
  }

  private async tick(): Promise<void> {
    await this.runPrimer(false);
  }

  private async runPrimer(manual: boolean): Promise<void> {
    if (this.disposed || (!manual && !this.enabled())) return;
    if (this.running) {
      if (manual) void vscode.window.showWarningMessage("Codex Quota Primer is already checking or confirming a primer; no additional request was sent.");
      return;
    }
    this.running = true;
    const lifecycle = this.lifecycle;
    try {
      await this.ensureClient();
      let limits = await this.readRateLimits();
      let journal = await this.readJournal();
      let state = this.mergeJournal(this.reconcileTracking(this.state(), limits), journal);
      this.logObservation(state, limits);
      await this.saveState(state);
      if (state.pendingConfirmation) {
        await this.refreshPendingJournal(state, journal, limits);
        journal = await this.readJournal();
        state = this.mergeJournal(this.reconcileTracking(this.state(), limits), journal);
        await this.saveState(state);
        if (state.pendingConfirmation) throw new PrimerSuppressed("a primer continuation is awaiting confirmation");
      }
      const candidates = this.candidateWindows(state, limits);
      if (!manual && !candidates.primary && !candidates.secondary) {
        await this.saveState(state);
        return;
      }
      await this.requireSafety(limits, state.threadId, manual, lifecycle);
      const observedAtMs = Date.now();
      const probe = manual ? { state, moving: candidates, fixed: {}, unknown: {} }
        : this.probeCandidateWindows(state, limits, candidates, observedAtMs);
      state = probe.state;
      await this.saveState(state);
      const dormant = probe.moving;
      if (!manual && !dormant.primary && !dormant.secondary) return;
      if (!manual) await delay(this.jitterMs());
      if (!manual) await this.waitForMotionSample(observedAtMs);
      // Jitter can overlap work recovery, quota exhaustion, or a window becoming
      // fixed through natural usage. All three are checked again before locking.
      limits = await this.readRateLimits();
      await this.requireSafety(limits, state.threadId, manual, lifecycle);
      const sendLock = await tryAcquireQuotaPrimerSendLock(this.context.globalStorageUri.fsPath, this.output);
      if (!sendLock) throw new PrimerSuppressed("another window is preparing a primer");
      let pending: QuotaPrimerJournalPending | undefined;
      let authorizedWindows: DueWindows = {};
      try {
        journal = await this.readJournal();
        state = this.mergeJournal(this.state(), journal);
        if (state.pendingConfirmation) throw new PrimerSuppressed("another window has an unconfirmed primer");
        limits = await this.readRateLimits();
        await this.requireSafety(limits, state.threadId, manual, lifecycle);
        const hooks: PrimerDispatchHooks = {
          beforeDispatch: async (threadId, beforeTurnId) => {
            limits = await this.readRateLimits();
            await this.requireSafety(limits, threadId, manual, lifecycle);
            journal = await this.readJournal();
            if (journal.pending) throw new PrimerSuppressed("another primer is awaiting confirmation");
            authorizedWindows = manual ? candidates : this.finalDormantWindows(
              probe.state, limits, dormant, journal,
            );
            if (!manual && !authorizedWindows.primary && !authorizedWindows.secondary) {
              throw new PrimerSuppressed("quota window is fixed or its motion is uncertain");
            }
            pending = {
              threadId, beforeTurnId, manual,
              primaryResetAtMs: authorizedWindows.primary, secondaryResetAtMs: authorizedWindows.secondary,
              primaryProbeObservedAtMs: authorizedWindows.primary ? Date.now() : undefined,
              primaryProbeResetAtMs: authorizedWindows.primary ? resetAtMs(limits?.primary ?? null) : undefined,
              secondaryProbeObservedAtMs: authorizedWindows.secondary ? Date.now() : undefined,
              secondaryProbeResetAtMs: authorizedWindows.secondary ? resetAtMs(limits?.secondary ?? null) : undefined,
              sentAtMs: Date.now(),
            };
            await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, { ...journal, threadId, pending });
            await this.saveState({ ...this.state(), threadId, pendingConfirmation: pending });
            try {
              const recovery = await readRecoveryPriority(this.context.globalStorageUri.fsPath);
              this.requireLifecycle(manual, lifecycle);
              if (recovery.status !== "clear") throw new PrimerSuppressed("active or uncertain recovery has priority");
            } catch (error) {
              await hooks.rejected();
              throw error;
            }
          },
          accepted: async (turnId) => {
            if (pending && turnId) {
              pending = { ...pending, turnId };
              await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, { ...journal, threadId: pending.threadId, pending });
              await this.saveState({ ...this.state(), pendingConfirmation: pending });
            }
            await sendLock.release();
          },
          rejected: async () => {
            if (!pending) return;
            await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, { ...journal, threadId: pending.threadId, pending: undefined });
            await this.saveState({ ...this.state(), pendingConfirmation: undefined });
            pending = undefined;
          },
        };
        const result = await this.sendPrimer(state, manual ? "quota-primer-manual" : "quota-primer", hooks);
        if (result.turn && pending) await this.recordObservedTurn(pending, result.turn);
        if (manual) {
          const message = result.turn && primerTurnAccepted(result.turn)
            ? `Codex Quota Primer sent a manual primer turn on ${result.threadId} using ${result.model.model}.`
            : "Codex Quota Primer sent one attempt and is awaiting confirmation; no duplicate will be sent.";
          void vscode.window.showInformationMessage(message);
        }
      } finally {
        await sendLock.release();
      }
    } catch (error) {
      const message = (error as Error).message;
      this.suppressed(message);
      if (manual) void vscode.window.showWarningMessage(`Codex Quota Primer cannot prime now: ${message}.`);
      if (!(error instanceof PrimerSuppressed)) {
        this.client?.dispose();
        this.client = undefined;
      }
    } finally {
      this.running = false;
      this.renderStatus();
      this.scheduleNextTick();
    }
  }

  private requireLifecycle(manual: boolean, lifecycle: number): void {
    if (this.disposed || this.lifecycle !== lifecycle || (!manual && !this.enabled())) {
      throw new PrimerSuppressed("primer checking was cancelled");
    }
  }

  private async waitForMotionSample(observedAtMs: number): Promise<void> {
    // Prove the window is still moving after the candidate sample. Comparing
    // only to its older sample could miss real usage starting during jitter.
    await delay(Math.max(0, WINDOW_PROBE_MIN_ELAPSED_MS - (Date.now() - observedAtMs)));
  }

  private async requireSafety(limits: RateLimitSnapshot | null, threadId: string | undefined,
    manual: boolean, lifecycle: number): Promise<void> {
    this.requireLifecycle(manual, lifecycle);
    if (!this.quotaLooksAvailable(limits)) throw new PrimerSuppressed("account quota is blocked, unknown, or contradictory");
    if (await this.hasActiveCodexThread(threadId)) throw new PrimerSuppressed("Codex has active work or its activity is unknown");
    const recovery = await readRecoveryPriority(this.context.globalStorageUri.fsPath);
    if (recovery.status !== "clear") {
      throw new PrimerSuppressed(recovery.status === "active" ? "active recovery has priority" : "recovery coordination is unavailable");
    }
    this.requireLifecycle(manual, lifecycle);
  }

  private suppressed(reason: string): void {
    if (reason !== this.lastSuppression) this.output.appendLine(`[quota-primer] primer suppressed: ${reason}; monitoring continues`);
    this.lastSuppression = reason;
  }

  private async readJournal(): Promise<QuotaPrimerSendJournal> {
    const result = await readQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath);
    if (result.status !== "ready") throw new PrimerSuppressed(result.reason);
    return result.journal;
  }

  private mergeJournal(state: QuotaPrimerState, journal: QuotaPrimerSendJournal): QuotaPrimerState {
    return {
      ...state,
      threadId: journal.updatedAtMs === 0 ? state.threadId : journal.pending?.threadId ?? journal.threadId,
      knownPrimerThreadIds: migrateQuotaPrimerState({ ...state,
        knownPrimerThreadIds: [...(state.knownPrimerThreadIds ?? []), ...(journal.knownPrimerThreadIds ?? []),
          ...(journal.threadId ? [journal.threadId] : []), ...(journal.pending ? [journal.pending.threadId] : [])],
      }).knownPrimerThreadIds,
      // Only a missing journal can import legacy local state. An existing host
      // journal supersedes stale per-window Memento confirmation caches.
      pendingConfirmation: journal.updatedAtMs === 0 ? state.pendingConfirmation : journal.pending,
      primary: journal.handledPrimaryResetAtMs === undefined ? state.primary
        : { ...state.primary, lastHandledResetAtMs: journal.handledPrimaryResetAtMs,
          trackedResetAtMs: Math.max(state.primary?.trackedResetAtMs ?? 0, journal.nextPrimaryResetAtMs ?? 0) || undefined },
      secondary: journal.handledSecondaryResetAtMs === undefined ? state.secondary
        : { ...state.secondary, lastHandledResetAtMs: journal.handledSecondaryResetAtMs,
          trackedResetAtMs: Math.max(state.secondary?.trackedResetAtMs ?? 0, journal.nextSecondaryResetAtMs ?? 0) || undefined },
    };
  }

  private finalDormantWindows(current: QuotaPrimerState,
    limits: RateLimitSnapshot | null, due: DueWindows, journal: QuotaPrimerSendJournal): DueWindows {
    const result: DueWindows = {};
    for (const name of ["primary", "secondary"] as const) {
      const boundary = due[name];
      const handled = name === "primary" ? journal.handledPrimaryResetAtMs : journal.handledSecondaryResetAtMs;
      if (!boundary || boundary === handled || !windowLooksLikeDormantCandidate(limits?.[name] ?? null, Date.now())) continue;
      const sample = current[name];
      if (classifyWindowMotion(sample?.probeObservedAtMs, sample?.probeResetAtMs,
        Date.now(), resetAtMs(limits?.[name] ?? null)).motion === "moving") result[name] = boundary;
    }
    return result;
  }

  private async refreshPendingJournal(state: QuotaPrimerState, journal: QuotaPrimerSendJournal,
    limits: RateLimitSnapshot | null): Promise<void> {
    let pending = journal.pending ?? (state.pendingConfirmation && state.threadId
      ? { ...state.pendingConfirmation, threadId: state.threadId } : undefined);
    if (!pending) throw new PrimerSuppressed("legacy primer confirmation has no readable thread identity");
    const initialSentAtMs = pending.sentAtMs;
    // Migrate 0.3.9 pending confirmation under the same lock before inspecting it.
    if (!journal.pending) {
      const lock = await tryAcquireQuotaPrimerSendLock(this.context.globalStorageUri.fsPath, this.output);
      if (!lock) throw new PrimerSuppressed("another window is checking primer confirmation");
      try {
        const fresh = await this.readJournal();
        if (fresh.updatedAtMs !== 0) return;
        await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, { ...fresh, threadId: pending.threadId, pending });
      } finally { await lock.release(); }
    }
    if (!pending.turnId) {
      const turn = await this.findTurnAfterDispatch(pending);
      if (turn) pending = { ...pending, turnId: turn.id };
    }
    const turn = pending.turnId ? await this.turnById(pending.threadId, pending.turnId) : undefined;
    let refreshed: QuotaPrimerState = { ...state, threadId: pending.threadId, pendingConfirmation: pending };
    if (turn && classifyPrimerQuotaError(turn)) {
      refreshed.pendingConfirmation = undefined; // A structured failure definitively permits a later safe retry.
    } else if (turn?.status === "completed" && this.quotaLooksAvailable(limits)) {
      refreshed = pending.manual && !pending.primaryResetAtMs && !pending.secondaryResetAtMs
        ? { ...refreshed, pendingConfirmation: undefined }
        : await this.reconcilePendingConfirmation(refreshed, limits);
    }
    const lock = await tryAcquireQuotaPrimerSendLock(this.context.globalStorageUri.fsPath, this.output);
    if (!lock) return;
    try {
      journal = await this.readJournal();
      if (journal.pending?.sentAtMs !== initialSentAtMs || journal.pending.threadId !== pending.threadId) return;
      await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, {
        ...journal, pending: refreshed.pendingConfirmation ? { ...pending, ...refreshed.pendingConfirmation } : undefined,
        handledPrimaryResetAtMs: refreshed.primary?.lastHandledResetAtMs ?? journal.handledPrimaryResetAtMs,
        handledSecondaryResetAtMs: refreshed.secondary?.lastHandledResetAtMs ?? journal.handledSecondaryResetAtMs,
        nextPrimaryResetAtMs: refreshed.primary?.trackedResetAtMs ?? journal.nextPrimaryResetAtMs,
        nextSecondaryResetAtMs: refreshed.secondary?.trackedResetAtMs ?? journal.nextSecondaryResetAtMs,
      });
      await this.saveState(refreshed);
    } finally { await lock.release(); }
  }

  private async findTurnAfterDispatch(pending: QuotaPrimerJournalPending): Promise<CodexTurn | undefined> {
    const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId: pending.threadId, limit: 20, sortDirection: "desc", itemsView: "summary",
    });
    if (!Array.isArray(response?.data)) return undefined;
    const baseline = response.data.findIndex((turn) => turn.id === pending.beforeTurnId);
    if (baseline > 0) return response.data[0];
    if (baseline === 0) return undefined;
    return response.data.find((turn) => typeof turn.startedAt === "number" && turn.id !== pending.beforeTurnId &&
      (turn.startedAt < 10_000_000_000 ? turn.startedAt * 1000 : turn.startedAt) >= Math.floor(pending.sentAtMs / 1000) * 1000);
  }

  private async recordObservedTurn(pending: QuotaPrimerJournalPending, turn: CodexTurn): Promise<void> {
    const lock = await tryAcquireQuotaPrimerSendLock(this.context.globalStorageUri.fsPath, this.output);
    if (!lock) return;
    try {
      const journal = await this.readJournal();
      if (journal.pending?.sentAtMs !== pending.sentAtMs || journal.pending.threadId !== pending.threadId) return;
      const failed = Boolean(classifyPrimerQuotaError(turn));
      await writeQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath, {
        ...journal, pending: failed ? undefined : { ...journal.pending, turnId: turn.id },
      });
      await this.saveState({ ...this.state(), lastPrimeAtMs: Date.now(),
        pendingConfirmation: failed ? undefined : { ...journal.pending, turnId: turn.id } });
    } finally { await lock.release(); }
  }

  private reconcileTracking(state: QuotaPrimerState, limits: RateLimitSnapshot | null): QuotaPrimerState {
    const now = Date.now();
    return {
      ...state,
      primary: reconcileWindowState(
        state.primary,
        limits?.primary ?? null,
        now,
        this.graceMs(),
      ),
      secondary: reconcileWindowState(
        state.secondary,
        limits?.secondary ?? null,
        now,
        this.graceMs(),
      ),
    };
  }

  private candidateWindows(state: QuotaPrimerState, limits: RateLimitSnapshot | null): DueWindows {
    const now = Date.now();
    const candidates: DueWindows = {};

    if (
      this.primaryEnabled() &&
      (
        windowIsDue(state.primary, now, this.graceMs()) ||
        windowLooksLikeDormantCandidate(limits?.primary ?? null, now)
      )
    ) {
      candidates.primary = state.primary?.trackedResetAtMs ?? resetAtMs(limits?.primary ?? null);
    }

    if (
      this.secondaryEnabled() &&
      (
        windowIsDue(state.secondary, now, this.graceMs()) ||
        windowLooksLikeDormantCandidate(limits?.secondary ?? null, now)
      )
    ) {
      candidates.secondary = state.secondary?.trackedResetAtMs ?? resetAtMs(limits?.secondary ?? null);
    }

    return candidates;
  }

  private probeCandidateWindows(
    state: QuotaPrimerState,
    limits: RateLimitSnapshot | null,
    candidates: DueWindows,
    observedAtMs: number,
  ): {
    state: QuotaPrimerState;
    moving: DueWindows;
    fixed: DueWindows;
    unknown: DueWindows;
  } {
    let primary = state.primary;
    let secondary = state.secondary;
    const moving: DueWindows = {};
    const fixed: DueWindows = {};
    const unknown: DueWindows = {};

    if (candidates.primary) {
      const probe = observeWindowMotion(primary, limits?.primary ?? null, observedAtMs);
      primary = probe.state;
      this.logWindowProbe("primary", probe.classification, limits?.primary ?? null);
      if (probe.classification.motion === "moving") {
        moving.primary = candidates.primary;
      } else if (probe.classification.motion === "fixed") {
        fixed.primary = candidates.primary;
        primary = advanceHandledWindow(
          primary,
          candidates.primary,
          limits?.primary ?? null,
          observedAtMs,
        );
      } else {
        unknown.primary = candidates.primary;
      }
    }

    if (candidates.secondary) {
      const probe = observeWindowMotion(secondary, limits?.secondary ?? null, observedAtMs);
      secondary = probe.state;
      this.logWindowProbe("secondary", probe.classification, limits?.secondary ?? null);
      if (probe.classification.motion === "moving") {
        moving.secondary = candidates.secondary;
      } else if (probe.classification.motion === "fixed") {
        fixed.secondary = candidates.secondary;
        secondary = advanceHandledWindow(
          secondary,
          candidates.secondary,
          limits?.secondary ?? null,
          observedAtMs,
        );
      } else {
        unknown.secondary = candidates.secondary;
      }
    }

    return {
      state: { ...state, primary, secondary },
      moving,
      fixed,
      unknown,
    };
  }

  private logWindowProbe(
    name: "primary" | "secondary",
    classification: WindowProbeClassification,
    window: RateLimitWindow | null,
  ): void {
    if (classification.motion === "unknown") {
      this.output.appendLine(
        `[quota-primer] ${name} motion probe captured reset=${formatWindowReset(window)}; waiting for a later sample`,
      );
      return;
    }

    this.output.appendLine(
      `[quota-primer] ${name} motion probe=${classification.motion}; wallDelta=${formatDurationMs(classification.elapsedMs)}; resetDelta=${formatDurationMs(classification.resetDeltaMs)}; reset=${formatWindowReset(window)}`,
    );
  }

  private async reconcilePendingConfirmation(
    state: QuotaPrimerState,
    limits: RateLimitSnapshot | null,
  ): Promise<QuotaPrimerState> {
    const pending = state.pendingConfirmation;
    if (!pending) return this.reconcileTracking(state, limits);

    let tracked = this.reconcileTracking(state, limits);

    if (pending.turnId && state.threadId) {
      const turn = await this.turnById(state.threadId, pending.turnId);
      const explicitReason = classifyPrimerQuotaError(turn);
      const quotaBlockedWithoutStructuredError =
        Boolean(turn && (turn.status === "interrupted" || turn.status === "failed")) &&
        this.quotaLooksBlocked(limits);
      const reason = explicitReason ?? (quotaBlockedWithoutStructuredError ? "rateLimitReached" : undefined);
      if (reason) {
        this.output.appendLine(
          `[quota-primer] primer turn ${pending.turnId} was quota-blocked (${reason}); clearing confirmation and keeping the dormant reset boundary pending`,
        );
        return {
          ...tracked,
          pendingConfirmation: undefined,
        };
      }
    }

    const observedAtMs = Date.now();
    let nextPending: QuotaPrimerPendingConfirmation = { ...pending };
    let primaryMotion: WindowMotion | undefined;
    let secondaryMotion: WindowMotion | undefined;

    if (pending.primaryResetAtMs) {
      const classification = classifyWindowMotion(
        pending.primaryProbeObservedAtMs,
        pending.primaryProbeResetAtMs,
        observedAtMs,
        resetAtMs(limits?.primary ?? null),
      );
      primaryMotion = classification.motion;
      this.logWindowProbe("primary", classification, limits?.primary ?? null);

      if (classification.motion === "fixed") {
        tracked = {
          ...tracked,
          primary: advanceHandledWindow(
            tracked.primary,
            pending.primaryResetAtMs,
            limits?.primary ?? null,
            observedAtMs,
          ),
        };
        nextPending = {
          ...nextPending,
          primaryResetAtMs: undefined,
          primaryProbeObservedAtMs: undefined,
          primaryProbeResetAtMs: undefined,
        };
      } else {
        nextPending.primaryProbeObservedAtMs = observedAtMs;
        nextPending.primaryProbeResetAtMs = resetAtMs(limits?.primary ?? null);
      }
    }

    if (pending.secondaryResetAtMs) {
      const classification = classifyWindowMotion(
        pending.secondaryProbeObservedAtMs,
        pending.secondaryProbeResetAtMs,
        observedAtMs,
        resetAtMs(limits?.secondary ?? null),
      );
      secondaryMotion = classification.motion;
      this.logWindowProbe("secondary", classification, limits?.secondary ?? null);

      if (classification.motion === "fixed") {
        tracked = {
          ...tracked,
          secondary: advanceHandledWindow(
            tracked.secondary,
            pending.secondaryResetAtMs,
            limits?.secondary ?? null,
            observedAtMs,
          ),
        };
        nextPending = {
          ...nextPending,
          secondaryResetAtMs: undefined,
          secondaryProbeObservedAtMs: undefined,
          secondaryProbeResetAtMs: undefined,
        };
      } else {
        nextPending.secondaryProbeObservedAtMs = observedAtMs;
        nextPending.secondaryProbeResetAtMs = resetAtMs(limits?.secondary ?? null);
      }
    }

    if (!nextPending.primaryResetAtMs && !nextPending.secondaryResetAtMs) {
      this.output.appendLine(
        `[quota-primer] confirmed quota window activation after primer turn ${pending.turnId ?? "<unknown>"}: resetAt is now fixed; next resets: ${formatCurrentResets(limits)}`,
      );
      return {
        ...tracked,
        pendingConfirmation: undefined,
      };
    }

    const stillMoving =
      primaryMotion === "moving" ||
      secondaryMotion === "moving";
    if (
      stillMoving &&
      Date.now() - pending.sentAtMs >= WINDOW_PROBE_RETRY_MS &&
      !pending.stalledWarningLogged
    ) {
      this.output.appendLine(
        `[quota-primer] resetAt is still moving more than ${WINDOW_PROBE_RETRY_MS / 1000}s after primer turn ${pending.turnId ?? "<unknown>"}; keeping this turn pending and refusing to send duplicate automatic primers for the same boundary`,
      );
      nextPending.stalledWarningLogged = true;
    }

    return {
      ...tracked,
      pendingConfirmation: nextPending,
    };
  }

  private async sendPrimer(
    state: QuotaPrimerState,
    logPrefix: string,
    hooks: PrimerDispatchHooks,
  ): Promise<{ threadId: string; turn?: CodexTurn; model: PrimerModelChoice }> {
    const model = await this.choosePrimerModel();
    await this.saveState({ ...this.state(), model: model.model, effort: model.effort });
    const prompt = this.prompt();

    if (state.threadId) {
      const before = await this.latestTurnSafe(state.threadId);

      // First ask the Codex UI router whether the official client already owns
      // this thread. If it does, send through that owner without surfacing the
      // conversation, so automatic priming stays invisible to the user.
      await hooks.beforeDispatch(state.threadId, before?.id);
      const sentSilently = await trySendTurnThroughExistingOfficialOwner(
        state.threadId,
        prompt,
        this.output,
        logPrefix,
        { model: model.model, effort: model.effort },
      );
      if (sentSilently) {
        await hooks.accepted();
        const turn = await this.waitForUiPrimerTurn(
          state.threadId,
          before?.id,
          logPrefix,
        );
        return { threadId: state.threadId, turn, model };
      }
      await hooks.rejected();

      let directDispatchStarted = false;
      const directHooks: PrimerDispatchHooks = {
        ...hooks,
        beforeDispatch: async (threadId, beforeTurnId) => {
          await hooks.beforeDispatch(threadId, beforeTurnId);
          directDispatchStarted = true;
        },
      };
      try {
        // No official UI owner currently has the thread mounted. A short-lived
        // writer can therefore resume it without changing the visible Codex UI.
        const turn = await this.writePrimerTurnDirect(state.threadId, prompt, model, directHooks, before?.id);
        return { threadId: state.threadId, turn, model };
      } catch (error) {
        if (error instanceof PrimerSuppressed || directDispatchStarted) throw error;
        const message = (error as Error).message;
        this.output.appendLine(`[${logPrefix}] direct primer resume failed: ${message}`);

        if (looksLikeMissingThread(message)) {
          this.output.appendLine(
            `[${logPrefix}] stored primer thread no longer exists; creating a new dedicated primer conversation`,
          );
        } else if (looksLikeWriterConflict(message)) {
          // A race can occur between silent owner discovery and acquiring the
          // writer lock. Surface the exact thread only as the final recovery
          // path, then route through the official owner.
          await hooks.beforeDispatch(state.threadId, before?.id);
          const sent = await sendTurnThroughOfficialCodexUi(
            state.threadId,
            prompt,
            this.output,
            logPrefix,
            { model: model.model, effort: model.effort },
          );
          if (sent) {
            await hooks.accepted();
            const turn = await this.waitForUiPrimerTurn(
              state.threadId,
              before?.id,
              logPrefix,
            );
            return { threadId: state.threadId, turn, model };
          }
          await hooks.rejected();
          return { threadId: state.threadId, model };
        } else {
          return { threadId: state.threadId, model };
        }
      }
    }

    const created = await this.createPrimerThread(prompt, model, hooks);
    return { threadId: created.threadId, turn: created.turn, model };
  }

  private async createPrimerThread(
    prompt: string,
    model: PrimerModelChoice,
    hooks: PrimerDispatchHooks,
  ): Promise<{ threadId: string; turn?: CodexTurn }> {
    const writer = this.createPrimerWriter();
    try {
      await writer.start();
      const threadCwd = this.primerThreadCwd();
      const started = await writer.request<ThreadStartResponse>("thread/start", {
        model: model.model,
        cwd: threadCwd,
        serviceName: PRIMER_THREAD_SOURCE,
        threadSource: PRIMER_THREAD_SOURCE,
        ephemeral: false,
      });

      const threadId = started.thread.id;
      await this.saveState({
        ...this.state(),
        threadId,
        threadCwd,
        model: model.model,
        effort: model.effort,
      });

      try {
        await writer.request("thread/name/set", {
          threadId,
          name: PRIMER_THREAD_NAME,
        });
      } catch (error) {
        this.output.appendLine(
          `[quota-primer] could not name the new primer thread: ${(error as Error).message}`,
        );
      }

      this.output.appendLine(
        `[quota-primer] created dedicated primer thread ${threadId} using ${model.model}${model.effort ? ` / ${model.effort}` : ""}; cwd=${threadCwd}; source=${formatThreadSource(started.thread.source)}; originator=${started.thread.originator ?? "<none>"}`,
      );

      const turn = await startPrimerTurnAndWait(
        writer,
        threadId,
        prompt,
        model,
        this.output,
        hooks,
      );
      return { threadId, turn };
    } finally {
      writer.dispose();
    }
  }

  private async writePrimerTurnDirect(
    threadId: string,
    prompt: string,
    model: PrimerModelChoice,
    hooks: PrimerDispatchHooks,
    beforeTurnId?: string,
  ): Promise<CodexTurn | undefined> {
    const writer = this.createPrimerWriter();
    try {
      await writer.start();
      await writer.request("thread/resume", { threadId }, 20_000);
      return await startPrimerTurnAndWait(
        writer,
        threadId,
        prompt,
        model,
        this.output,
        hooks,
        beforeTurnId,
      );
    } finally {
      writer.dispose();
    }
  }

  private primerThreadCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private createPrimerWriter(): CodexRpcClient {
    return new CodexRpcClient(
      resolveCodexExecutable(this.output),
      this.output,
      {
        name: "codex-auto-resume-primer",
        title: "Codex Auto Resume Quota Primer",
        version: "0.3.9",
      },
    );
  }

  private async choosePrimerModel(): Promise<PrimerModelChoice> {
    const models = await this.listModels();
    if (models.length === 0) throw new Error("Codex model/list returned no models.");

    const preference = this.modelPreference().toLowerCase();
    const exact = models.find((item) =>
      [item.id, item.model, item.displayName].some((value) => value.toLowerCase() === preference),
    );
    const contains = models
      .filter((item) =>
        [item.id, item.model, item.displayName].some((value) => value.toLowerCase().includes(preference)),
      )
      .sort((a, b) => cheapModelScore(b) - cheapModelScore(a));
    const cheapFallback = models
      .filter((item) => cheapModelScore(item) > 0)
      .sort((a, b) => cheapModelScore(b) - cheapModelScore(a))[0];

    let selected = exact ?? contains[0];
    let fallback = false;

    if (!selected) {
      if (!this.allowModelFallback()) {
        throw new Error(
          `Preferred Primer model "${this.modelPreference()}" is unavailable. Automatic priming was skipped rather than silently using a potentially more expensive model.`,
        );
      }

      const defaultModel = models.find((item) => item.isDefault);
      selected = cheapFallback ?? defaultModel ?? models.find((item) => !item.hidden) ?? models[0];
      fallback = true;
    }

    const effort = chooseReasoningEffort(selected, this.effortPreference());
    if (fallback) {
      this.output.appendLine(
        `[quota-primer] preferred model "${this.modelPreference()}" is unavailable; explicit fallback is enabled, using ${selected.model} (${selected.displayName})`,
      );
    } else {
      this.output.appendLine(
        `[quota-primer] selected low-cost model ${selected.model} (${selected.displayName})${effort ? ` with effort=${effort}` : ""}`,
      );
    }

    return {
      model: selected.model,
      displayName: selected.displayName,
      effort,
      fallback,
    };
  }

  private async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const response: ModelListResponse = await this.client!.request<ModelListResponse>("model/list", {
        limit: 100,
        includeHidden: true,
        cursor,
      });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return models;
  }

  private async readRateLimits(): Promise<RateLimitSnapshot | null> {
    this.quotaResponse = undefined;
    try {
      const response = await this.client!.request<RateLimitsReadResponse>(
        "account/rateLimits/read",
        { excludeResetCreditDetails: true },
        30_000,
      );
      this.quotaResponse = response;
      return response.rateLimits ?? null;
    } catch (error) {
      const message = (error as Error).message;
      if (!/excludeResetCreditDetails|unknown field|invalid params?/i.test(message)) throw error;
      const response = await this.client!.request<RateLimitsReadResponse>(
        "account/rateLimits/read",
        {},
        30_000,
      );
      this.quotaResponse = response;
      return response.rateLimits ?? null;
    }
  }

  private async hasActiveCodexThread(primerThreadId?: string): Promise<boolean> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: ThreadListResponse = await this.client!.request<ThreadListResponse>("thread/list", {
        limit: 100, sortKey: "updated_at", sortDirection: "desc", archived: false, cursor,
      });
      if (!Array.isArray(response?.data) || !(response.nextCursor === null || typeof response.nextCursor === "string")) return true;
      for (const thread of response.data) {
        if (!thread || typeof thread.id !== "string" || !thread.status ||
            !["active", "idle", "inactive", "notLoaded", "systemError"].includes(thread.status.type)) return true;
        if (thread.id !== primerThreadId && (thread.status.type === "active" || thread.status.type === "systemError")) return true;
      }
      cursor = response.nextCursor;
      if (cursor && seen.has(cursor)) return true;
      if (cursor) seen.add(cursor);
      if (seen.size > 100) return true;
    } while (cursor);
    return false;
  }

  private async latestTurnSafe(threadId: string): Promise<CodexTurn | undefined> {
    try {
      const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      });
      return response.data[0];
    } catch (error) {
      this.output.appendLine(
        `[quota-primer] could not read latest turn for ${threadId}: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  private async turnById(threadId: string, turnId: string): Promise<CodexTurn | undefined> {
    try {
      const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      });
      return response.data.find((turn) => turn.id === turnId);
    } catch {
      return undefined;
    }
  }

  private async waitForUiPrimerTurn(
    threadId: string,
    beforeTurnId: string | undefined,
    logPrefix: string,
  ): Promise<CodexTurn | undefined> {
    let turnId: string | undefined;
    let stableSinceMs: number | undefined;
    let lastStatus: string | undefined;
    const pendingRead = await readQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath);
    const pending = pendingRead.status === "ready" ? pendingRead.journal.pending : undefined;

    for (let attempt = 1; attempt <= UI_PRIMER_CONFIRMATION_POLLS; attempt += 1) {
      await delay(1_000);

      if (!turnId) {
        const latest = pending && pending.threadId === threadId && pending.beforeTurnId === beforeTurnId
          ? await this.findTurnAfterDispatch(pending) : undefined;
        if (!latest?.id || latest.id === beforeTurnId) {
          if (attempt <= 12) {
            this.output.appendLine(
              `[${logPrefix}] verification ${attempt}/12 waiting for a new primer turn`,
            );
          }
          continue;
        }
        turnId = latest.id;
        this.output.appendLine(
          `[${logPrefix}] primer turn ${turnId} appeared on the dedicated thread; entering second-stage verification`,
        );
      }

      const turn = await this.turnById(threadId, turnId);
      if (!turn) continue;

      if (turn.status !== lastStatus) {
        lastStatus = turn.status;
        this.output.appendLine(
          `[${logPrefix}] primer turn ${turn.id} status=${turn.status}; error=${formatPrimerTurnError(turn)}`,
        );
      }

      if (turn.status === "completed") {
        this.output.appendLine(
          `[${logPrefix}] primer turn ${turn.id} confirmed completed`,
        );
        return turn;
      }

      if (turn.status === "failed" || (turn.status === "interrupted" && Boolean(turn.error))) {
        this.output.appendLine(
          `[${logPrefix}] primer turn ${turn.id} ended unsuccessfully; status=${turn.status}; error=${formatPrimerTurnError(turn)}`,
        );
        return turn;
      }

      if (turn.status === "inProgress") {
        stableSinceMs ??= Date.now();
        if (Date.now() - stableSinceMs >= UI_PRIMER_STABILITY_MS) {
          this.output.appendLine(
            `[${logPrefix}] primer turn ${turn.id} remained in progress without an error for ${UI_PRIMER_STABILITY_MS / 1_000}s; accepting it as stably started`,
          );
          return turn;
        }
        continue;
      }

      // interrupted/error=null is a transient state observed in Codex history
      // while the official owner catches up. It is neither success nor failure.
      stableSinceMs = undefined;
    }

    this.output.appendLine(
      `[${logPrefix}] primer turn verification timed out after ${UI_PRIMER_CONFIRMATION_POLLS}s; treating the attempt as unconfirmed`,
    );
    return undefined;
  }

  private quotaLooksBlocked(limits: RateLimitSnapshot | null): boolean {
    return classifyQuotaAvailability(this.quotaResponse && { ...this.quotaResponse, rateLimits: limits }).status === "blocked";
  }

  private quotaLooksAvailable(limits: RateLimitSnapshot | null): boolean {
    const availability = classifyQuotaAvailability(this.quotaResponse && { ...this.quotaResponse, rateLimits: limits });
    const waitingReason = availability.status === "available" ? undefined : availability.reason;
    if (waitingReason && waitingReason !== this.waitingReason) {
      this.output.appendLine(`[quota-primer] enabled; waiting for available quota (${waitingReason})`);
    }
    this.waitingReason = waitingReason;
    return availability.status === "available";
  }

  private scheduleNextTick(): void {
    if (!this.enabled() || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = Math.max(
      15,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("quotaPrimer.pollIntervalSeconds", 60),
    );
    this.timer = setTimeout(() => void this.tick(), seconds * 1_000);
  }

  private primaryEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<boolean>("quotaPrimer.primaryEnabled", true);
  }

  private secondaryEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<boolean>("quotaPrimer.secondaryEnabled", true);
  }

  private graceMs(): number {
    const seconds = Math.max(
      0,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("quotaPrimer.graceSeconds", 90),
    );
    return seconds * 1_000;
  }

  private jitterMs(): number {
    const maxSeconds = Math.max(
      0,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("quotaPrimer.jitterSeconds", 15),
    );
    return Math.floor(Math.random() * (maxSeconds + 1)) * 1_000;
  }

  private prompt(): string {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<string>(
        "quotaPrimer.prompt",
        "Quota window primer. Reply exactly OK. Do not inspect files, run tools, or modify anything.",
      );
  }

  private modelPreference(): string {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<string>("quotaPrimer.modelPreference", "luna")
      .trim() || "luna";
  }

  private effortPreference(): string {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<string>("quotaPrimer.reasoningEffort", "lowest")
      .trim() || "lowest";
  }

  private allowModelFallback(): boolean {
    return vscode.workspace
      .getConfiguration("codexAutoResume")
      .get<boolean>("quotaPrimer.allowModelFallback", false);
  }

  private logObservation(state: QuotaPrimerState, limits: RateLimitSnapshot | null): void {
    const observation = [
      state.threadId ?? "none",
      state.primary?.trackedResetAtMs ?? "none",
      state.secondary?.trackedResetAtMs ?? "none",
      state.pendingConfirmation?.turnId ?? "none",
      limits?.rateLimitReachedType ?? "none",
      limits?.primary?.usedPercent ?? "none",
      limits?.secondary?.usedPercent ?? "none",
    ].join("|");
    if (observation === this.lastObservation) return;
    this.lastObservation = observation;
    this.output.appendLine(
      `[quota-primer] observed thread=${state.threadId ?? "<not-created>"}; ${formatRateLimits(limits)}; trackedPrimary=${formatReset(state.primary?.trackedResetAtMs)}; trackedSecondary=${formatReset(state.secondary?.trackedResetAtMs)}`,
    );
  }

  private renderStatus(): void {
    if (!this.enabled()) {
      this.statusBar.text = "$(circle-slash) Codex Primer: Off";
      this.statusBar.tooltip = "Quota Window Primer is disabled";
      return;
    }

    const state = this.state();
    if (this.waitingReason && !state.pendingConfirmation) {
      this.statusBar.text = "$(clock) Codex Primer: Waiting";
      this.statusBar.tooltip = `Enabled; waiting for available quota (${this.waitingReason}); monitoring continues`;
      return;
    }
    if (state.pendingConfirmation) {
      this.statusBar.text = "$(sync) Codex Primer: Confirming";
      this.statusBar.tooltip = `Waiting for quota windows to advance after primer turn ${state.pendingConfirmation.turnId ?? ""}`;
      return;
    }

    const nextReset = [
      this.primaryEnabled() ? state.primary?.trackedResetAtMs : undefined,
      this.secondaryEnabled() ? state.secondary?.trackedResetAtMs : undefined,
    ]
      .filter((value): value is number => typeof value === "number" && value > Date.now())
      .sort((a, b) => a - b)[0];

    if (nextReset) {
      this.statusBar.text = `$(clock) Codex Primer: ${new Date(nextReset).toLocaleTimeString()}`;
      this.statusBar.tooltip = `Watching quota reset at ${new Date(nextReset).toLocaleString()}`;
    } else {
      this.statusBar.text = "$(pulse) Codex Primer: Watching";
      this.statusBar.tooltip = "Watching account quota windows for a reset boundary";
    }
  }
}

function reconcileWindowState(
  state: QuotaPrimerWindowState | undefined,
  window: RateLimitWindow | null,
  nowMs: number,
  graceMs: number,
): QuotaPrimerWindowState | undefined {
  if (!window) return state;

  const currentResetAtMs = resetAtMs(window);
  if (!currentResetAtMs) {
    return {
      ...state,
      windowDurationMins: window.windowDurationMins,
    };
  }

  const trackedResetAtMs = state?.trackedResetAtMs;
  if (!trackedResetAtMs) {
    return {
      ...state,
      trackedResetAtMs: currentResetAtMs,
      windowDurationMins: window.windowDurationMins,
    };
  }

  const boundaryStillPending =
    state?.lastHandledResetAtMs !== trackedResetAtMs &&
    nowMs >= trackedResetAtMs + graceMs;

  // Once an old boundary has become due, never replace it merely because the
  // backend starts returning a future resetAt. A dormant rolling window
  // reports approximately "now + duration", so blindly adopting that value
  // creates a moving target that can never become due.
  //
  // The same protection is used for a zero-usage full-duration window even
  // when the extension starts after the original boundary was already missed.
  if (
    boundaryStillPending ||
    windowLooksLikeDormantCandidate(window, nowMs)
  ) {
    return {
      ...state,
      windowDurationMins: window.windowDurationMins,
    };
  }

  if (
    currentResetAtMs > nowMs &&
    Math.abs(currentResetAtMs - trackedResetAtMs) > RESET_JITTER_TOLERANCE_MS
  ) {
    return {
      ...state,
      trackedResetAtMs: currentResetAtMs,
      windowDurationMins: window.windowDurationMins,
      probeObservedAtMs: undefined,
      probeResetAtMs: undefined,
    };
  }

  return {
    ...state,
    windowDurationMins: window.windowDurationMins,
  };
}

function windowIsDue(
  state: QuotaPrimerWindowState | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  const boundary = state?.trackedResetAtMs;
  if (!boundary || state?.lastHandledResetAtMs === boundary) return false;
  return nowMs >= boundary + graceMs;
}

function observeWindowMotion(
  state: QuotaPrimerWindowState | undefined,
  window: RateLimitWindow | null,
  observedAtMs: number,
): {
  state: QuotaPrimerWindowState | undefined;
  classification: WindowProbeClassification;
} {
  const currentResetAtMs = resetAtMs(window);
  const classification = classifyWindowMotion(
    state?.probeObservedAtMs,
    state?.probeResetAtMs,
    observedAtMs,
    currentResetAtMs,
  );

  return {
    state: {
      ...state,
      windowDurationMins: window?.windowDurationMins ?? state?.windowDurationMins,
      probeObservedAtMs: observedAtMs,
      probeResetAtMs: currentResetAtMs,
    },
    classification,
  };
}

function advanceHandledWindow(
  state: QuotaPrimerWindowState | undefined,
  boundary: number | undefined,
  current: RateLimitWindow | null,
  observedAtMs: number,
): QuotaPrimerWindowState | undefined {
  if (!state || !boundary) return state;

  const nextResetAtMs = resetAtMs(current);
  return {
    ...state,
    lastHandledResetAtMs: boundary,
    trackedResetAtMs:
      nextResetAtMs && nextResetAtMs > observedAtMs
        ? nextResetAtMs
        : state.trackedResetAtMs,
    windowDurationMins: current?.windowDurationMins ?? state.windowDurationMins,
    probeObservedAtMs: undefined,
    probeResetAtMs: undefined,
  };
}

function formatDurationMs(value: number | undefined): string {
  if (value === undefined) return "<none>";
  return `${(value / 1000).toFixed(1)}s`;
}

function cheapModelScore(model: CodexModel): number {
  const text = `${model.id} ${model.model} ${model.displayName}`.toLowerCase();
  let score = 0;
  if (text.includes("luna")) score += 100;
  if (text.includes("light")) score += 30;
  if (text.includes("mini")) score += 20;
  if (text.includes("nano")) score += 20;
  if (!model.hidden) score += 2;
  return score;
}

function chooseReasoningEffort(model: CodexModel, preference: string): string | undefined {
  const supported = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
  if (supported.length === 0) return model.defaultReasoningEffort || undefined;

  if (preference !== "lowest") {
    const exact = supported.find((effort) => effort.toLowerCase() === preference.toLowerCase());
    if (exact) return exact;
  }

  const rank = new Map([
    ["none", 0],
    ["minimal", 1],
    ["light", 2],
    ["low", 3],
    ["medium", 4],
    ["high", 5],
    ["xhigh", 6],
    ["ultra", 7],
  ]);
  return [...supported].sort(
    (a, b) => (rank.get(a.toLowerCase()) ?? 100) - (rank.get(b.toLowerCase()) ?? 100),
  )[0];
}

async function startPrimerTurnAndWait(
  client: CodexRpcClient,
  threadId: string,
  prompt: string,
  model: PrimerModelChoice,
  output: vscode.OutputChannel,
  hooks: PrimerDispatchHooks,
  beforeTurnId?: string,
): Promise<CodexTurn | undefined> {
  let completedNotification: CodexTurn | undefined;
  const onNotification = (method: string, params: unknown): void => {
    if (method !== "turn/completed") return;
    const record = asRecord(params);
    if (!record || record.threadId !== threadId) return;
    const turn = asRecord(record.turn);
    if (!turn || typeof turn.id !== "string") return;
    completedNotification = turn as unknown as CodexTurn;
  };
  client.on("notification", onNotification);

  try {
    await hooks.beforeDispatch(threadId, beforeTurnId);
    const response = await client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: model.model,
      ...(model.effort ? { effort: model.effort } : {}),
    }, 30_000);
    if (!response?.turn?.id) throw new Error("Primer turn/start returned no turn identity; keeping send intent pending");
    await hooks.accepted(response.turn.id);
    if (["completed", "failed"].includes(response.turn.status) ||
        (response.turn.status === "interrupted" && response.turn.error)) return response.turn;

    let lastStatus: string | undefined;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      if (completedNotification?.id === response.turn.id) {
        output.appendLine(
          `[quota-primer] direct primer turn ${response.turn.id} completed via turn/completed notification; status=${completedNotification.status}`,
        );
        return completedNotification;
      }

      await delay(1_000);
      const turns = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      });
      const turn = turns.data.find((item) => item.id === response.turn.id);
      if (!turn) continue;

      if (turn.status !== lastStatus) {
        lastStatus = turn.status;
        output.appendLine(
          `[quota-primer] direct primer turn ${turn.id} observed status=${turn.status}; error=${formatPrimerTurnError(turn)}`,
        );
      }

      if (
        turn.status === "completed" ||
        turn.status === "failed" ||
        (turn.status === "interrupted" && Boolean(turn.error))
      ) {
        return turn;
      }

      if (turn.status === "interrupted" && !turn.error) {
        continue;
      }
    }

    output.appendLine(
      `[quota-primer] direct primer turn ${response.turn.id} did not reach a terminal state within 120s; treating the attempt as unconfirmed instead of reporting success`,
    );
    return undefined;
  } finally {
    client.off("notification", onNotification);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function formatPrimerTurnError(turn: CodexTurn): string {
  const info = turn.error?.codexErrorInfo;
  if (typeof info === "string") return info;
  if (info) return JSON.stringify(info);
  return turn.error?.message ?? "none";
}

function formatThreadSource(source: unknown): string {
  if (typeof source === "string") return source;
  try {
    return JSON.stringify(source);
  } catch {
    return "<unknown>";
  }
}

function primerTurnAccepted(turn: CodexTurn): boolean {
  return turn.status === "completed" || turn.status === "inProgress";
}

function classifyPrimerQuotaError(turn: CodexTurn | undefined): string | undefined {
  const info = turn?.error?.codexErrorInfo;
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return info;
  return undefined;
}

function looksLikeMissingThread(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("not found") || value.includes("missing") || value.includes("no rollout");
}

function looksLikeWriterConflict(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("active writer") || value.includes("thread-store conflict") || value.includes("writer lock");
}

function formatTrackedWindow(name: string, state: QuotaPrimerWindowState | undefined): string {
  return `${name} next reset ${formatReset(state?.trackedResetAtMs)}`;
}

function formatReset(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : "<unknown>";
}

function formatDueWindows(due: DueWindows): string {
  const names: string[] = [];
  if (due.primary) names.push("primary");
  if (due.secondary) names.push("secondary");
  return names.join("+") || "none";
}

function formatCurrentResets(limits: RateLimitSnapshot | null): string {
  return [
    `primary=${formatWindowReset(limits?.primary ?? null)}`,
    `secondary=${formatWindowReset(limits?.secondary ?? null)}`,
  ].join("; ");
}

function formatRateLimits(limits: RateLimitSnapshot | null): string {
  if (!limits) return "rateLimits=<none>";
  return [
    `rateLimitReachedType=${limits.rateLimitReachedType ?? "none"}`,
    `primary=${limits.primary?.usedPercent ?? "none"}% reset=${formatWindowReset(limits.primary)}`,
    `secondary=${limits.secondary?.usedPercent ?? "none"}% reset=${formatWindowReset(limits.secondary)}`,
  ].join("; ");
}

function formatWindowReset(window: RateLimitWindow | null): string {
  if (!window || typeof window.resetsAt !== "number") return "none";
  return new Date(window.resetsAt * 1_000).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
