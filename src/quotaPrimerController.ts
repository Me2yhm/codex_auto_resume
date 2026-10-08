import * as os from "os";
import * as vscode from "vscode";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import {
  sendTurnThroughOfficialCodexUi,
  trySendTurnThroughExistingOfficialOwner,
} from "./officialCodexUi";
import {
  QUOTA_PRIMER_STATE_KEY,
  QuotaPrimerPendingConfirmation,
  QuotaPrimerState,
  QuotaPrimerWindowState,
} from "./quotaPrimerState";
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
const PRIMER_THREAD_SOURCE = "codex-auto-resume-primer";
const RESET_ADVANCE_TOLERANCE_MS = 60_000;
const RESET_JITTER_TOLERANCE_MS = 5_000;
const PRIMER_CONFIRMATION_POLL_MS = 1_000;
const PRIMER_CONFIRMATION_POLLS = 12;
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

export class QuotaPrimerController implements vscode.Disposable {
  private client?: CodexRpcClient;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastObservation?: string;
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
    await this.ensureClient();
    const limits = await this.readRateLimits();
    if (this.quotaLooksBlocked(limits)) {
      void vscode.window.showWarningMessage(
        "Codex Quota Primer cannot prime now because the account is currently quota-blocked.",
      );
      return;
    }

    const state = this.reconcileTracking(this.state(), limits);
    await this.saveState(state);
    const result = await this.sendPrimer(state, "quota-primer-manual");
    if (!result.turn || !primerTurnAccepted(result.turn)) {
      void vscode.window.showWarningMessage(
        `Codex Quota Primer did not get a confirmed successful primer turn${result.turn ? ` (status=${result.turn.status}, error=${formatPrimerTurnError(result.turn)})` : ""}. See the Codex Auto Resume output for details.`,
      );
      return;
    }

    const freshLimits = await this.readRateLimits();
    const refreshed = this.reconcileTracking(
      {
        ...this.state(),
        lastPrimeAtMs: Date.now(),
      },
      freshLimits,
    );
    await this.saveState(refreshed);
    void vscode.window.showInformationMessage(
      `Codex Quota Primer sent a manual primer turn on ${result.threadId} using ${result.model.model}${result.model.effort ? ` / ${result.model.effort}` : ""}.`,
    );
  }

  async resetPrimerThread(): Promise<void> {
    const state = this.state();
    await this.saveState({
      ...state,
      threadId: undefined,
      threadCwd: undefined,
      model: undefined,
      effort: undefined,
      pendingConfirmation: undefined,
    });
    void vscode.window.showInformationMessage(
      "Codex Quota Primer forgot its dedicated thread. The next primer will create a new dedicated conversation.",
    );
  }

  dispose(): void {
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
    return this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY) ?? {};
  }

  private async saveState(state: QuotaPrimerState): Promise<void> {
    await this.context.globalState.update(QUOTA_PRIMER_STATE_KEY, state);
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
    if (!this.enabled() || this.running) return;
    this.running = true;

    try {
      await this.ensureClient();
      let limits = await this.readRateLimits();
      let state = this.reconcileTracking(this.state(), limits);
      this.logObservation(state, limits);

      if (state.pendingConfirmation) {
        state = await this.reconcilePendingConfirmation(state, limits);
        await this.saveState(state);
        if (state.pendingConfirmation) return;
      }

      let due = this.dueWindows(state, limits);
      if (!due.primary && !due.secondary) {
        await this.saveState(state);
        return;
      }

      if (this.quotaLooksBlocked(limits)) {
        this.output.appendLine(
          `[quota-primer] reset boundary is due (${formatDueWindows(due)}), but another quota blocker is still active; waiting`,
        );
        await this.saveState(state);
        return;
      }

      if (await this.hasActiveCodexThread(state.threadId)) {
        this.output.appendLine(
          `[quota-primer] reset boundary is due (${formatDueWindows(due)}), but Codex currently has an active thread; skipping this poll`,
        );
        await this.saveState(state);
        return;
      }

      const jitterMs = this.jitterMs();
      if (jitterMs > 0) {
        this.output.appendLine(
          `[quota-primer] reset boundary is due (${formatDueWindows(due)}); waiting ${Math.round(jitterMs / 1000)}s before the final preflight check`,
        );
        await delay(jitterMs);
      }

      limits = await this.readRateLimits();
      state = this.reconcileTracking(this.state(), limits);
      due = this.dueWindows(state, limits);
      if (!due.primary && !due.secondary) {
        this.output.appendLine(
          "[quota-primer] another Codex request already started the new quota window during preflight; no primer was sent",
        );
        await this.saveState(state);
        return;
      }
      if (this.quotaLooksBlocked(limits) || await this.hasActiveCodexThread(state.threadId)) {
        this.output.appendLine(
          "[quota-primer] preflight no longer permits a primer; keeping the reset boundary pending",
        );
        await this.saveState(state);
        return;
      }

      const result = await this.sendPrimer(state, "quota-primer");
      if (!result.turn || !primerTurnAccepted(result.turn)) {
        if (result.turn) {
          this.output.appendLine(
            `[quota-primer] primer turn ${result.turn.id} was not accepted as successful; status=${result.turn.status}; error=${formatPrimerTurnError(result.turn)}; keeping the reset boundary pending`,
          );
        }
        await this.saveState(this.state());
        return;
      }

      const pending: QuotaPrimerPendingConfirmation = {
        primaryResetAtMs: due.primary,
        secondaryResetAtMs: due.secondary,
        turnId: result.turn.id,
        sentAtMs: Date.now(),
      };
      state = {
        ...this.state(),
        model: result.model.model,
        effort: result.model.effort,
        pendingConfirmation: pending,
        lastPrimeAtMs: Date.now(),
      };
      await this.saveState(state);
      this.output.appendLine(
        `[quota-primer] sent one primer turn ${result.turn.id} for ${formatDueWindows(due)}; waiting for account rate-limit windows to advance`,
      );

      for (let attempt = 1; attempt <= PRIMER_CONFIRMATION_POLLS; attempt += 1) {
        await delay(PRIMER_CONFIRMATION_POLL_MS);
        limits = await this.readRateLimits();
        state = await this.reconcilePendingConfirmation(this.state(), limits);
        await this.saveState(state);
        if (!state.pendingConfirmation) break;
      }
    } catch (error) {
      this.output.appendLine(`[quota-primer] tick failed: ${(error as Error).message}`);
      this.client?.dispose();
      this.client = undefined;
    } finally {
      this.running = false;
      this.renderStatus();
      this.scheduleNextTick();
    }
  }

  private reconcileTracking(state: QuotaPrimerState, limits: RateLimitSnapshot | null): QuotaPrimerState {
    return {
      ...state,
      primary: reconcileWindowState(state.primary, limits?.primary ?? null),
      secondary: reconcileWindowState(state.secondary, limits?.secondary ?? null),
    };
  }

  private dueWindows(state: QuotaPrimerState, limits: RateLimitSnapshot | null): DueWindows {
    const now = Date.now();
    const due: DueWindows = {};

    if (this.primaryEnabled() && windowIsDue(state.primary, limits?.primary ?? null, now, this.graceMs())) {
      due.primary = state.primary?.trackedResetAtMs;
    }
    if (this.secondaryEnabled() && windowIsDue(state.secondary, limits?.secondary ?? null, now, this.graceMs())) {
      due.secondary = state.secondary?.trackedResetAtMs;
    }

    return due;
  }

  private async reconcilePendingConfirmation(
    state: QuotaPrimerState,
    limits: RateLimitSnapshot | null,
  ): Promise<QuotaPrimerState> {
    const pending = state.pendingConfirmation;
    if (!pending) return this.reconcileTracking(state, limits);

    const tracked = this.reconcileTracking(state, limits);
    const primaryConfirmed = boundaryConfirmed(pending.primaryResetAtMs, limits?.primary ?? null);
    const secondaryConfirmed = boundaryConfirmed(pending.secondaryResetAtMs, limits?.secondary ?? null);

    if (primaryConfirmed && secondaryConfirmed) {
      const next = {
        ...tracked,
        primary: markBoundaryHandled(tracked.primary, pending.primaryResetAtMs),
        secondary: markBoundaryHandled(tracked.secondary, pending.secondaryResetAtMs),
        pendingConfirmation: undefined,
      };
      this.output.appendLine(
        `[quota-primer] confirmed new quota window(s) after primer turn ${pending.turnId ?? "<unknown>"}; next resets: ${formatCurrentResets(limits)}`,
      );
      return next;
    }

    if (pending.turnId && state.threadId) {
      const turn = await this.turnById(state.threadId, pending.turnId);
      const explicitReason = classifyPrimerQuotaError(turn);
      const quotaBlockedWithoutStructuredError =
        Boolean(turn && (turn.status === "interrupted" || turn.status === "failed")) &&
        this.quotaLooksBlocked(limits);
      const reason = explicitReason ?? (quotaBlockedWithoutStructuredError ? "rateLimitReached" : undefined);
      if (reason) {
        this.output.appendLine(
          `[quota-primer] primer turn ${pending.turnId} was quota-blocked (${reason}); clearing the attempt and waiting for the blocker to clear`,
        );
        return {
          ...tracked,
          pendingConfirmation: undefined,
        };
      }
    }

    return tracked;
  }

  private async sendPrimer(
    state: QuotaPrimerState,
    logPrefix: string,
  ): Promise<{ threadId: string; turn?: CodexTurn; model: PrimerModelChoice }> {
    const model = await this.choosePrimerModel();
    const prompt = this.prompt();

    if (state.threadId) {
      const before = await this.latestTurnSafe(state.threadId);

      // First ask the Codex UI router whether the official client already owns
      // this thread. If it does, send through that owner without surfacing the
      // conversation, so automatic priming stays invisible to the user.
      const sentSilently = await trySendTurnThroughExistingOfficialOwner(
        state.threadId,
        prompt,
        this.output,
        logPrefix,
        { model: model.model, effort: model.effort },
      );
      if (sentSilently) {
        const turn = await this.waitForUiPrimerTurn(
          state.threadId,
          before?.id,
          logPrefix,
        );
        return { threadId: state.threadId, turn, model };
      }

      try {
        // No official UI owner currently has the thread mounted. A short-lived
        // writer can therefore resume it without changing the visible Codex UI.
        const turn = await this.writePrimerTurnDirect(state.threadId, prompt, model);
        return { threadId: state.threadId, turn, model };
      } catch (error) {
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
          const sent = await sendTurnThroughOfficialCodexUi(
            state.threadId,
            prompt,
            this.output,
            logPrefix,
            { model: model.model, effort: model.effort },
          );
          if (sent) {
            const turn = await this.waitForUiPrimerTurn(
              state.threadId,
              before?.id,
              logPrefix,
            );
            return { threadId: state.threadId, turn, model };
          }
          return { threadId: state.threadId, model };
        } else {
          return { threadId: state.threadId, model };
        }
      }
    }

    const created = await this.createPrimerThread(prompt, model);
    return { threadId: created.threadId, turn: created.turn, model };
  }

  private async createPrimerThread(
    prompt: string,
    model: PrimerModelChoice,
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
        version: "0.3.2",
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
    const defaultModel = models.find((item) => item.isDefault);
    const selected = exact ?? contains[0] ?? cheapFallback ?? defaultModel ?? models.find((item) => !item.hidden) ?? models[0];
    const fallback = !exact && contains.length === 0;

    const effort = chooseReasoningEffort(selected, this.effortPreference());
    if (fallback) {
      this.output.appendLine(
        `[quota-primer] preferred model "${this.modelPreference()}" is unavailable; falling back to ${selected.model} (${selected.displayName})`,
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
    const response = await this.client!.request<RateLimitsReadResponse>("account/rateLimits/read", {});
    return response.rateLimits ?? null;
  }

  private async hasActiveCodexThread(primerThreadId?: string): Promise<boolean> {
    const response = await this.client!.request<ThreadListResponse>("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    });
    return response.data.some(
      (thread) => thread.id !== primerThreadId && thread.status?.type === "active",
    );
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

    for (let attempt = 1; attempt <= UI_PRIMER_CONFIRMATION_POLLS; attempt += 1) {
      await delay(1_000);

      if (!turnId) {
        const latest = await this.latestTurnSafe(threadId);
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
    if (!limits) return true;
    if (limits.rateLimitReachedType) return true;
    const windows = [limits.primary, limits.secondary].filter(
      (window): window is RateLimitWindow => Boolean(window),
    );
    return windows.some((window) => window.usedPercent >= 99);
  }

  private scheduleNextTick(): void {
    if (!this.enabled()) return;
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
): QuotaPrimerWindowState | undefined {
  if (!window) return state;
  const currentResetAtMs = typeof window.resetsAt === "number" ? window.resetsAt * 1_000 : undefined;
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

  if (
    currentResetAtMs > Date.now() &&
    Math.abs(currentResetAtMs - trackedResetAtMs) > RESET_JITTER_TOLERANCE_MS
  ) {
    return {
      ...state,
      trackedResetAtMs: currentResetAtMs,
      windowDurationMins: window.windowDurationMins,
    };
  }

  return {
    ...state,
    windowDurationMins: window.windowDurationMins,
  };
}

function windowIsDue(
  state: QuotaPrimerWindowState | undefined,
  current: RateLimitWindow | null,
  nowMs: number,
  graceMs: number,
): boolean {
  const boundary = state?.trackedResetAtMs;
  if (!boundary || state?.lastHandledResetAtMs === boundary) return false;
  if (nowMs < boundary + graceMs) return false;

  const currentResetAtMs = typeof current?.resetsAt === "number" ? current.resetsAt * 1_000 : undefined;
  if (
    currentResetAtMs &&
    currentResetAtMs > nowMs &&
    currentResetAtMs > boundary + RESET_ADVANCE_TOLERANCE_MS
  ) {
    return false;
  }

  return true;
}

function boundaryConfirmed(boundary: number | undefined, current: RateLimitWindow | null): boolean {
  if (!boundary) return true;
  const currentResetAtMs = typeof current?.resetsAt === "number" ? current.resetsAt * 1_000 : undefined;
  return Boolean(
    currentResetAtMs &&
      currentResetAtMs > Date.now() &&
      currentResetAtMs > boundary + RESET_ADVANCE_TOLERANCE_MS,
  );
}

function markBoundaryHandled(
  state: QuotaPrimerWindowState | undefined,
  boundary: number | undefined,
): QuotaPrimerWindowState | undefined {
  if (!state || !boundary) return state;
  return {
    ...state,
    lastHandledResetAtMs: boundary,
  };
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
    const response = await client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: model.model,
      ...(model.effort ? { effort: model.effort } : {}),
    }, 30_000);

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
