import * as path from "path";
import * as vscode from "vscode";
import { classifyQuotaAvailability } from "./quotaAvailability";
import { RecoveryCoordinator } from "./recoveryCoordination";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import { sendTurnThroughOfficialCodexUi } from "./officialCodexUi";
import { QUOTA_PRIMER_STATE_KEY, QuotaPrimerState } from "./quotaPrimerState";
import { addTextToOfficialCodexThread, tryNativeChatSubmit } from "./officialCodexBridge";
import {
  ArmedResume,
  CodexThread,
  PendingQuotaInterruption,
  CodexTurn,
  RateLimitSnapshot,
  RateLimitsReadResponse,
  ThreadListResponse,
  ThreadTurnsListResponse,
} from "./types";

const STATE_KEY = "codexAutoResume.armed";
const PENDING_QUOTA_CANDIDATE_KEY = "codexAutoResume.pendingQuotaCandidate";
const RESUME_OBSERVATION_POLL_MS = 1_000;
const AVAILABILITY_CONFIRMATION_MS = 10_000;
const AVAILABILITY_CONFIRMATION_TIMEOUT_MS = 30_000;

interface RateLimitReadResult {
  ok: boolean;
  limits: RateLimitSnapshot | null;
}

export class AutoResumeController implements vscode.Disposable {
  private readonly recovery: RecoveryCoordinator;
  private coordinationUnavailable = false;
  private client?: CodexRpcClient;
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private lifecycleEpoch = 0;
  private tickEpoch?: number;
  private availabilityCandidate?: { threadId: string; armedAtMs: number; observedAtMs: number };
  private lastObservation?: string;
  private lastResumeObservation?: string;
  private lastThreadSelectionDiagnostic?: string;
  private lastStaleThreadDiagnostic?: string;
  private lastRateLimitReadDiagnostic?: string;
  private quotaResponse?: RateLimitsReadResponse;
  private recycleClientAfterTick = false;
  private statusBar: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.recovery = new RecoveryCoordinator(
      context.globalStorageUri.fsPath,
      vscode.workspace.workspaceFile?.fsPath ?? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath).join("|"),
      output,
    );
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = "codexAutoResume.status";
    this.statusBar.show();
    this.renderStatus();
  }

  async start(): Promise<void> {
    if (!this.enabled()) {
      this.lifecycleEpoch += 1;
      this.availabilityCandidate = undefined;
      await this.syncRecoveryPriority();
      this.renderStatus();
      return;
    }
    // tick() owns client initialization and sets the re-entrancy guard before
    // awaiting anything. This makes config-change + Enable races harmless.
    await this.tick();
  }

  async enable(): Promise<void> {
    await vscode.workspace.getConfiguration("codexAutoResume").update("enabled", true, vscode.ConfigurationTarget.Global);
    await this.start();
    const armed = this.armed();
    if (armed?.resumeTurnId || armed?.dispatchPending) {
      void vscode.window.showInformationMessage(
        `Codex Auto Resume enabled and verifying ${armed.resumeTurnId ? `resume turn ${armed.resumeTurnId}` : "a pending continuation"} for ${armed.threadId}.`,
      );
    } else if (armed) {
      const reset = new Date(armed.resetAtMs).toLocaleString();
      void vscode.window.showInformationMessage(
        `Codex Auto Resume enabled and armed for ${armed.threadId}. Expected backend reset ${reset}; confirmed quota availability can resume earlier.`,
      );
    } else {
      void vscode.window.showInformationMessage("Codex Auto Resume enabled.");
    }
  }

  async disable(): Promise<void> {
    this.lifecycleEpoch += 1;
    await vscode.workspace.getConfiguration("codexAutoResume").update("enabled", false, vscode.ConfigurationTarget.Global);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.availabilityCandidate = undefined;
    await this.saveArmed(undefined);
    await this.context.workspaceState.update(PENDING_QUOTA_CANDIDATE_KEY, undefined);
    await this.syncRecoveryPriority();
    this.renderStatus();
    void vscode.window.showInformationMessage("Codex Auto Resume disabled.");
  }

  async showStatus(): Promise<void> {
    const armed = this.armed();
    if (!this.enabled()) {
      void vscode.window.showInformationMessage("Codex Auto Resume is disabled.");
      return;
    }
    if (!armed) {
      const pending = this.pendingQuotaCandidate();
      if (pending) {
        void vscode.window.showInformationMessage(
          `Codex Auto Resume is monitoring an interrupted turn ${pending.turnId} on thread ${pending.threadId}, but account quota state is temporarily unavailable. It will arm only after quota interruption is confirmed.`,
        );
        return;
      }
      void vscode.window.showInformationMessage("Codex Auto Resume is enabled and monitoring; no interrupted thread is armed.");
      return;
    }
    if (armed.resumeTurnId || armed.dispatchPending) {
      void vscode.window.showInformationMessage(
        `Codex Auto Resume is verifying ${armed.resumeTurnId ? `resume turn ${armed.resumeTurnId}` : "a pending continuation"} on thread ${armed.threadId}. It will not send another continuation until this attempt is classified.`,
      );
      return;
    }
    const reset = new Date(armed.resetAtMs).toLocaleString();
    void vscode.window.showInformationMessage(
      `Codex Auto Resume is ${this.availabilityCandidate ? "Confirming availability" : "Armed (awaiting availability)"} for thread ${armed.threadId}. Expected backend reset ${reset}; confirmed quota availability can resume earlier.`,
    );
  }

  async resumeNow(): Promise<void> {
    if (this.armed()?.resumeTurnId || this.armed()?.dispatchPending) {
      void vscode.window.showWarningMessage("A continuation is already being verified. Inspect the exact conversation before attempting another continuation.");
      return;
    }
    await this.ensureClient();
    const thread = await this.findMostRecentThread();
    if (!thread) throw new Error("No recent VS Code Codex thread found for the current workspace.");
    const prompt = this.resumePrompt();
    const before = await this.latestTurn(thread.id);
    const success = await this.sendThroughOfficialUi(thread.id, prompt, "resume-now");
    if (!success) {
      void vscode.window.showWarningMessage(
        "Codex Auto Resume could not find an active UI owner for this thread. Open that exact Codex conversation and try Resume Now again.",
      );
      return;
    }
    const verified = await this.verifyNewTurn(thread.id, before?.id, "resume-now");
    if (verified) {
      void vscode.window.showInformationMessage("Codex Auto Resume sent the continuation prompt to the same thread.");
    }
  }

  async testOfficialSubmitBridge(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "This legacy test will add a harmless prompt to the current Codex thread and invoke VS Code's native chat submit command. It is retained only for diagnostics and is expected to fail for the Codex sidebar.",
      { modal: true },
      "Run Legacy Test",
    );
    if (confirmed !== "Run Legacy Test") return;

    await this.ensureClient();
    const thread = await this.findMostRecentThread();
    if (!thread) throw new Error("No recent VS Code Codex thread found for the current workspace.");
    const before = await this.latestTurn(thread.id);
    const marker = `CODEX_AUTO_RESUME_BRIDGE_TEST_${Date.now()}`;
    const prompt = `${marker}\nThis is a transport smoke test. Reply exactly BRIDGE_OK and do not modify any files.`;

    this.output.show(true);
    this.output.appendLine(`[bridge] target thread: ${thread.id}`);
    this.output.appendLine(`[bridge] latest turn before test: ${before?.id ?? "<none>"}`);
    await addTextToOfficialCodexThread(prompt, this.output);
    await delay(500);
    await tryNativeChatSubmit(this.output);
    await this.verifyNewTurn(thread.id, before?.id, "bridge");
  }

  async testOfficialUiIpcBridge(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "This test will send one harmless prompt to the current Codex conversation through the official Codex UI IPC owner. It may create a quota-failed test turn if your quota is still exhausted.",
      { modal: true },
      "Run UI IPC Test",
    );
    if (confirmed !== "Run UI IPC Test") return;

    await this.ensureClient();
    const thread = await this.findMostRecentThread();
    if (!thread) throw new Error("No recent VS Code Codex thread found for the current workspace.");
    const before = await this.latestTurn(thread.id);
    const marker = `CODEX_AUTO_RESUME_UI_IPC_TEST_${Date.now()}`;
    const prompt = `${marker}\nThis is a transport smoke test. Reply exactly IPC_BRIDGE_OK and do not modify any files.`;

    this.output.show(true);
    this.output.appendLine(`[ui-ipc-test] target thread: ${thread.id}`);
    this.output.appendLine(`[ui-ipc-test] latest turn before test: ${before?.id ?? "<none>"}`);

    const sent = await this.sendThroughOfficialUi(thread.id, prompt, "ui-ipc-test");
    if (!sent) {
      this.output.appendLine(
        "[ui-ipc-test] NO OWNER: open the exact target conversation in the Codex sidebar, wait a few seconds, and run this test again.",
      );
      void vscode.window.showWarningMessage(
        "No Codex UI IPC owner was found for the target thread. Open the exact interrupted conversation in the Codex sidebar, wait 2-3 seconds, then run the UI IPC bridge test again.",
      );
      return;
    }

    const success = await this.verifyNewTurn(thread.id, before?.id, "ui-ipc-test");
    if (success) {
      void vscode.window.showInformationMessage(
        "Codex UI IPC bridge succeeded: the official thread owner created a new turn on the same conversation.",
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.availabilityCandidate = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.client?.dispose();
    this.recovery.dispose();
    this.statusBar.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("codexAutoResume").get<boolean>("enabled", false);
  }

  private canMonitor(): boolean {
    return this.enabled() && !this.disposed && (this.tickEpoch === undefined || this.tickEpoch === this.lifecycleEpoch);
  }

  private armed(): ArmedResume | undefined {
    return this.context.workspaceState.get<ArmedResume>(STATE_KEY);
  }

  private pendingQuotaCandidate(): PendingQuotaInterruption | undefined {
    return this.context.workspaceState.get<PendingQuotaInterruption>(PENDING_QUOTA_CANDIDATE_KEY);
  }

  private async savePendingQuotaCandidate(candidate: PendingQuotaInterruption | undefined): Promise<void> {
    if (candidate && !this.canMonitor()) return;
    await this.context.workspaceState.update(PENDING_QUOTA_CANDIDATE_KEY, candidate);
    await this.syncRecoveryPriority();
  }

  private async saveArmed(armed: ArmedResume | undefined): Promise<void> {
    if (armed && !this.canMonitor()) return;
    await this.context.workspaceState.update(STATE_KEY, armed);
    await this.syncRecoveryPriority();
  }

  private async syncRecoveryPriority(): Promise<void> {
    const armed = this.armed();
    const pending = this.pendingQuotaCandidate();
    const registration = !this.enabled() || this.disposed ? undefined
      : armed ? { phase: armed.resumeTurnId || armed.dispatchPending ? "verifying" as const : "armed" as const, threadId: armed.threadId }
      : pending ? { phase: "pending" as const, threadId: pending.threadId } : undefined;
    try {
      await this.recovery.set(registration);
      if (this.coordinationUnavailable) this.output.appendLine("[auto-resume] same-host recovery registration recovered");
      this.coordinationUnavailable = false;
    } catch {
      if (!this.coordinationUnavailable) this.output.appendLine("[auto-resume] same-host recovery registration unavailable; work recovery monitoring continues");
      this.coordinationUnavailable = true;
    }
  }

  private resumePrompt(): string {
    return vscode.workspace.getConfiguration("codexAutoResume").get<string>(
      "resumePrompt",
      "继续。从中断处恢复，先检查当前工作区已有修改和上一轮状态，不要重复已经完成的工作。",
    );
  }

  private async ensureClient(): Promise<void> {
    if (this.client?.isRunning) return;
    this.client?.dispose();
    this.client = new CodexRpcClient(resolveCodexExecutable(this.output), this.output);
    this.client.on("error", (error: Error) => this.output.appendLine(`[rpc] ${error.message}`));
    this.client.on("close", () => this.output.appendLine("[rpc] Codex app-server disconnected"));
    await this.client.start();
  }

  private async tick(): Promise<void> {
    if (!this.enabled() || this.disposed || this.running) return;
    this.running = true;
    this.tickEpoch = this.lifecycleEpoch;
    try {
      await this.syncRecoveryPriority();
      await this.ensureClient();

      // Account usage reads can be slower or temporarily unavailable on Remote
      // SSH hosts. Treat them as best-effort so local thread-store inspection
      // can continue even when the backend usage endpoint times out.
      const rateRead = await this.tryReadRateLimits();
      const limits = rateRead.limits;
      if (!this.canMonitor()) return;
      const armed = this.armed();

      if (armed?.resumeTurnId) {
        this.availabilityCandidate = undefined;
        await this.checkTrackedResumeAttempt(armed, limits);
      } else if (armed?.dispatchPending) {
        this.availabilityCandidate = undefined;
        await this.checkPendingDispatch(armed);
      } else if (armed) {
        await this.checkAvailabilityForResume(armed, limits);
      } else {
        const pending = this.pendingQuotaCandidate();
        if (pending) {
          const resolution = await this.resolvePendingQuotaCandidate(
            pending,
            limits,
            rateRead.ok,
          );
          if (resolution === "armed") return;
          if (resolution === "pending" && pending.reason) return;
        }

        const interrupted = await this.findInterruptedThread(limits, rateRead.ok);
        if (interrupted) {
          const resetAtMs = this.computeResetAt(limits);
          if (resetAtMs) {
            await this.armInterruptedThread(
              interrupted.thread,
              interrupted.turn,
              interrupted.reason,
              resetAtMs,
            );
          } else {
            await this.savePendingQuotaCandidate({
              threadId: interrupted.thread.id,
              cwd: interrupted.thread.cwd,
              turnId: interrupted.turn.id,
              observedAtMs: Date.now(),
              reason: interrupted.reason,
            });
            this.output.appendLine(
              `[auto-resume] detected quota interruption for ${interrupted.thread.id}, but no future reset timestamp is available yet; saved the exact turn and will retry account quota reads`,
            );
          }
        }
      }
    } catch (error) {
      this.availabilityCandidate = undefined;
      this.output.appendLine(`[auto-resume] tick failed: ${(error as Error).message}`);
      this.client?.dispose();
      this.client = undefined;
    } finally {
      if (this.recycleClientAfterTick) {
        this.recycleClientAfterTick = false;
        this.client?.dispose();
        this.client = undefined;
      }
      this.running = false;
      this.tickEpoch = undefined;
      this.renderStatus();
      this.scheduleNextTick();
    }
  }

  private async resolvePendingQuotaCandidate(
    candidate: PendingQuotaInterruption,
    limits: RateLimitSnapshot | null,
    rateLimitsAvailable: boolean,
  ): Promise<"pending" | "armed" | "cleared"> {
    const turn = await this.turnById(candidate.threadId, candidate.turnId);
    if (!this.canMonitor()) return "pending";
    if (!turn) {
      this.output.appendLine(
        `[auto-resume] pending quota candidate turn ${candidate.turnId} is no longer readable; clearing it`,
      );
      await this.savePendingQuotaCandidate(undefined);
      return "cleared";
    }

    const explicitReason = candidate.reason ?? classifyLimitError(turn);
    const interrupted = turn.status === "interrupted" || turn.status === "failed";
    if (!explicitReason && !interrupted) {
      await this.savePendingQuotaCandidate(undefined);
      return "cleared";
    }

    if (!rateLimitsAvailable) {
      this.output.appendLine(
        `[auto-resume] pending interrupted turn ${candidate.turnId} is preserved while account quota state remains unavailable`,
      );
      return "pending";
    }

    let reason = explicitReason;
    if (!reason) {
      if (!this.quotaLooksBlocked(limits)) {
        this.output.appendLine(
          `[auto-resume] pending interrupted turn ${candidate.turnId} was not confirmed as quota-related once account state recovered; clearing it without resuming`,
        );
        await this.savePendingQuotaCandidate(undefined);
        return "cleared";
      }
      reason = "rateLimitReached";
    }

    const resetAtMs = this.computeResetAt(limits);
    if (resetAtMs) {
      const thread: CodexThread = {
        id: candidate.threadId,
        cwd: candidate.cwd,
        preview: "",
        updatedAt: Math.floor(candidate.observedAtMs / 1000),
        recencyAt: null,
        source: null,
        status: { type: "inactive" },
      };
      await this.armInterruptedThread(thread, turn, reason, resetAtMs);
      return "armed";
    }

    if (explicitReason && this.quotaLooksAvailable(limits)) {
      // The account endpoint may have been unreachable for long enough that
      // quota recovered before we could obtain its original reset timestamp.
      // A structured quota error proves the original interruption cause, so it
      // can enter availability confirmation without knowing the old reset time.
      const record: ArmedResume = {
        threadId: candidate.threadId,
        cwd: candidate.cwd,
        armedAtMs: candidate.observedAtMs,
        resetAtMs: Date.now() - this.resetGraceMs(),
        reason,
        interruptedTurnId: candidate.turnId,
      };
      await this.saveArmed(record);
      await this.savePendingQuotaCandidate(undefined);
      this.output.appendLine(
        `[auto-resume] account quota is already available for previously quota-failed thread ${candidate.threadId}; promoting the saved candidate for availability confirmation`,
      );
      await this.checkAvailabilityForResume(record, limits);
      return "armed";
    }

    this.output.appendLine(
      `[auto-resume] quota interruption for ${candidate.threadId} is confirmed, but the backend still does not expose a usable future reset timestamp; keeping the exact turn pending`,
    );
    return "pending";
  }

  private async armInterruptedThread(
    thread: CodexThread,
    turn: CodexTurn,
    reason: ArmedResume["reason"],
    resetAtMs: number,
  ): Promise<void> {
    if (!this.canMonitor()) return;
    const record: ArmedResume = {
      threadId: thread.id,
      cwd: thread.cwd,
      armedAtMs: Date.now(),
      resetAtMs,
      reason,
      interruptedTurnId: turn.id,
    };
    await this.saveArmed(record);
    await this.savePendingQuotaCandidate(undefined);
    this.output.appendLine(
      `[auto-resume] armed thread ${record.threadId} from turn ${turn.id}; reason=${record.reason}; backend reset ${new Date(resetAtMs).toISOString()}; actual quota availability will be independently confirmed before resuming`,
    );
  }

  private async checkAvailabilityForResume(armed: ArmedResume, limits: RateLimitSnapshot | null): Promise<void> {
    if (!this.quotaLooksAvailable(limits)) {
      if (this.availabilityCandidate) this.output.appendLine("[auto-resume] confirmation failed; quota is blocked, unknown, or contradictory");
      this.availabilityCandidate = undefined;
      const nextReset = this.computeResetAt(limits);
      if (nextReset && nextReset !== armed.resetAtMs) {
        await this.saveArmed({ ...armed, resetAtMs: nextReset });
      }
      return;
    }

    const now = Date.now();
    const candidate = this.availabilityCandidate;
    if (!candidate || candidate.threadId !== armed.threadId || candidate.armedAtMs !== armed.armedAtMs ||
        now - candidate.observedAtMs > AVAILABILITY_CONFIRMATION_TIMEOUT_MS) {
      this.availabilityCandidate = { threadId: armed.threadId, armedAtMs: armed.armedAtMs, observedAtMs: now };
      this.output.appendLine(`[auto-resume] ${now < armed.resetAtMs ? "early availability detected" : "availability detected"}; confirming with an independent read in 10s`);
      return;
    }
    if (now - candidate.observedAtMs < AVAILABILITY_CONFIRMATION_MS) return;
    this.availabilityCandidate = undefined;
    if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    this.output.appendLine(`[auto-resume] ${now < armed.resetAtMs ? "confirmed early resume" : "confirmed quota recovery"} for ${armed.threadId}`);
    await this.tryAutomaticResume(armed);
  }

  private async tryAutomaticResume(armed: ArmedResume): Promise<void> {
    const current = this.armed();
    if (!this.canMonitor() || !current || current.dispatchPending || current.resumeTurnId) return;
    const before = await this.latestTurn(armed.threadId);
    if (!before) return; // An unreadable history cannot prove a safe dispatch baseline.
    if (before.status === "completed" || before.status === "inProgress" ||
        (armed.interruptedTurnId && before.id !== armed.interruptedTurnId)) {
      // The user or owner has already continued this conversation. Observe it
      // through the same verification path instead of sending another prompt.
      await this.trackResumeTurn(armed, before);
      const tracking = this.armed();
      if (tracking?.resumeTurnId) await this.checkTrackedResumeAttempt(tracking, null);
      return;
    }
    if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    const pending: ArmedResume = {
      ...armed,
      dispatchPending: { beforeTurnId: before.id, sentAtMs: Date.now() },
    };
    // Persist before transport: timeout/socket-close does not prove that the
    // owner failed to receive the request. Only a definitive no-owner permits retry.
    await this.saveArmed(pending);
    if (!this.canMonitor() || !this.armed()?.dispatchPending) return;
    this.renderStatus();
    const sent = await this.sendThroughOfficialUi(armed.threadId, this.resumePrompt(), "auto-resume");
    if (!sent) {
      if (this.canMonitor() && this.armed()?.dispatchPending?.sentAtMs === pending.dispatchPending!.sentAtMs) {
        await this.saveArmed({ ...pending, dispatchPending: undefined });
      }
      this.output.appendLine(`[auto-resume] no active UI owner for ${armed.threadId}; keeping thread armed for a confirmed retry`);
      return;
    }
    const resumedTurn = await this.waitForNewTurn(armed.threadId, before.id, "auto-resume", pending.dispatchPending!.sentAtMs);
    if (!resumedTurn) {
      this.output.appendLine(`[auto-resume] start-turn accepted; dispatch pending for ${armed.threadId}; no duplicate continuation will be sent`);
      return;
    }
    await this.trackResumeTurn(pending, resumedTurn);
    const tracking = this.armed();
    if (tracking?.resumeTurnId) await this.observeTrackedResumeAttempt(tracking);
  }

  private async checkPendingDispatch(armed: ArmedResume): Promise<void> {
    const turn = await this.findTurnAfterDispatch(armed.threadId, armed.dispatchPending!.beforeTurnId, armed.dispatchPending!.sentAtMs);
    if (!turn) return;
    await this.trackResumeTurn(armed, turn);
    const tracking = this.armed();
    if (tracking?.resumeTurnId) await this.checkTrackedResumeAttempt(tracking, null);
  }

  private async trackResumeTurn(armed: ArmedResume, turn: CodexTurn): Promise<void> {
    if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    await this.saveArmed({
      ...armed, dispatchPending: undefined, resumeTurnId: turn.id,
      resumeStartedAtMs: Date.now(), resumeInProgressSinceMs: undefined,
    } satisfies ArmedResume);
    this.lastResumeObservation = undefined;
    this.output.appendLine(`[auto-resume] resume turn ${turn.id} appeared; keeping the thread armed until confirmed stable`);
  }

  private async observeTrackedResumeAttempt(initial: ArmedResume): Promise<void> {
    const deadline = Date.now() + Math.max(this.resumeStabilityMs() + 5_000, 20_000);
    let tracked = initial;

    while (Date.now() < deadline) {
      await delay(RESUME_OBSERVATION_POLL_MS);
      const current = this.armed();
      if (!current?.resumeTurnId || current.resumeTurnId !== tracked.resumeTurnId) return;
      tracked = current;

      const outcome = await this.checkTrackedResumeAttempt(tracked, null);
      if (outcome !== "pending") return;
    }

    this.output.appendLine(
      `[auto-resume] resume turn ${tracked.resumeTurnId} is still not conclusively classified after the immediate verification window; keeping it tracked and rechecking on the next poll`,
    );
  }

  private async checkTrackedResumeAttempt(
    armed: ArmedResume,
    limits: RateLimitSnapshot | null,
  ): Promise<"pending" | "disarmed" | "rearmed"> {
    const resumeTurnId = armed.resumeTurnId;
    if (!resumeTurnId) return "pending";

    const turn = await this.turnById(armed.threadId, resumeTurnId);
    if (!this.canMonitor() || this.armed()?.resumeTurnId !== resumeTurnId) return "pending";
    this.logResumeObservation(armed, turn, limits);
    if (!turn) {
      if (armed.resumeInProgressSinceMs !== undefined) {
        await this.saveArmed({ ...armed, resumeInProgressSinceMs: undefined });
      }
      return "pending";
    }

    const explicitReason = classifyLimitError(turn);
    if (explicitReason) {
      const reason = explicitReason ?? "rateLimitReached";
      const nextReset = this.computeResetAt(limits);
      const rearmed: ArmedResume = {
        ...armed,
        reason,
        resetAtMs: nextReset ?? armed.resetAtMs,
        resumeTurnId: undefined,
        resumeStartedAtMs: undefined,
        resumeInProgressSinceMs: undefined,
        interruptedTurnId: resumeTurnId,
        dispatchPending: undefined,
      };
      await this.saveArmed(rearmed);
      this.lastResumeObservation = undefined;
      this.output.appendLine(
        `[auto-resume] resume turn ${resumeTurnId} hit a quota limit (${reason}); keeping thread armed${nextReset ? ` until ${new Date(nextReset).toISOString()}` : " and waiting for rate-limit state to refresh"}`,
      );
      return "rearmed";
    }

    if (turn.status === "completed") {
      await this.saveArmed(undefined);
      this.lastResumeObservation = undefined;
      this.output.appendLine(
        `[auto-resume] resume turn ${resumeTurnId} completed; resumed and disarmed thread ${armed.threadId}`,
      );
      return "disarmed";
    }

    const startedAtMs = armed.resumeInProgressSinceMs ?? Date.now();
    if (turn.status === "inProgress" && armed.resumeInProgressSinceMs === undefined) {
      await this.saveArmed({ ...armed, resumeInProgressSinceMs: startedAtMs });
    } else if (turn.status !== "inProgress" && armed.resumeInProgressSinceMs !== undefined) {
      await this.saveArmed({ ...armed, resumeInProgressSinceMs: undefined });
    }
    if (turn.status === "inProgress" && Date.now() - startedAtMs >= this.resumeStabilityMs()) {
      await this.saveArmed(undefined);
      this.lastResumeObservation = undefined;
      this.output.appendLine(
        `[auto-resume] resume turn ${resumeTurnId} has remained in progress without a quota error for ${Math.round((Date.now() - startedAtMs) / 1000)}s; resumed and disarmed thread ${armed.threadId}`,
      );
      return "disarmed";
    }

    if ((turn.status === "failed" || turn.status === "interrupted") && !turn.error) {
      // The app-server can briefly persist a freshly-started turn as
      // interrupted/error=null before the owner catches up. Do not interpret
      // this transient state as either success or failure, and never resend
      // while the attempt remains tracked.
      return "pending";
    }

    if (turn.status === "failed" || turn.status === "interrupted") {
      // A non-quota terminal failure is outside the scope of automatic quota
      // recovery. Keep the tracked attempt instead of sending duplicate
      // continuation prompts. The user can inspect it or use Resume Now.
      return "pending";
    }

    return "pending";
  }

  private async sendThroughOfficialUi(threadId: string, prompt: string, logPrefix: string): Promise<boolean> {
    return sendTurnThroughOfficialCodexUi(threadId, prompt, this.output, logPrefix);
  }

  private scheduleNextTick(): void {
    if (!this.canMonitor()) return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = Math.max(15, vscode.workspace.getConfiguration("codexAutoResume").get<number>("pollIntervalSeconds", 60));
    const confirmationDelay = this.availabilityCandidate
      ? Math.max(0, this.availabilityCandidate.observedAtMs + AVAILABILITY_CONFIRMATION_MS - Date.now())
      : seconds * 1000;
    this.timer = setTimeout(() => void this.tick(), Math.min(seconds * 1000, confirmationDelay));
  }

  private async readRateLimits(): Promise<RateLimitSnapshot | null> {
    let response: RateLimitsReadResponse;
    try {
      response = await this.client!.request<RateLimitsReadResponse>(
        "account/rateLimits/read",
        { excludeResetCreditDetails: true },
        30_000,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (!/excludeResetCreditDetails|unknown field|invalid params?/i.test(message)) throw error;
      response = await this.client!.request<RateLimitsReadResponse>(
        "account/rateLimits/read",
        {},
        30_000,
      );
    }

    this.quotaResponse = response;
    return response.rateLimits ?? null;
  }

  private async tryReadRateLimits(): Promise<RateLimitReadResult> {
    try {
      const limits = await this.readRateLimits();
      if (this.lastRateLimitReadDiagnostic) {
        this.output.appendLine("[auto-resume] account quota read recovered");
        this.lastRateLimitReadDiagnostic = undefined;
      }
      return { ok: classifyQuotaAvailability(this.quotaResponse).status !== "unknown", limits };
    } catch (error) {
      this.quotaResponse = undefined;
      const message = (error as Error).message;
      if (
        process.platform === "linux" &&
        this.client &&
        !this.client.hasNetworkEnvironmentBridge
      ) {
        this.recycleClientAfterTick = true;
      }
      if (this.lastRateLimitReadDiagnostic !== message) {
        this.lastRateLimitReadDiagnostic = message;
        this.output.appendLine(
          `[auto-resume] account quota read unavailable: ${message}; continuing with thread-only observation`,
        );
        if (this.recycleClientAfterTick) {
          this.output.appendLine(
            "[auto-resume] monitoring app-server has no inherited official Codex network environment; it will be recycled after this tick so the next poll can rediscover a sibling proxy",
          );
        }
      }
      return { ok: false, limits: null };
    }
  }

  private async latestTurn(threadId: string): Promise<CodexTurn | undefined> {
    const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    return response.data[0];
  }

  private async turnById(threadId: string, turnId: string): Promise<CodexTurn | undefined> {
    const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary",
    });
    return response.data.find((turn) => turn.id === turnId);
  }

  private async findTurnAfterDispatch(threadId: string, beforeTurnId: string | undefined, sentAtMs: number): Promise<CodexTurn | undefined> {
    const response = await this.client!.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId, limit: 20, sortDirection: "desc", itemsView: "summary",
    });
    const candidate = response.data[0];
    if (!candidate || candidate.id === beforeTurnId) return undefined;
    const baselineIndex = response.data.findIndex(turn => turn.id === beforeTurnId);
    if (baselineIndex > 0) return candidate;
    const started = candidate.startedAt;
    const startedAtMs = typeof started === "number" ? (started < 1e12 ? started * 1000 : started) : undefined;
    return startedAtMs !== undefined && startedAtMs >= Math.floor(sentAtMs / 1000) * 1000 ? candidate : undefined;
  }

  private async waitForNewTurn(
    threadId: string,
    beforeTurnId: string | undefined,
    logPrefix: string,
    sentAtMs?: number,
  ): Promise<CodexTurn | undefined> {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await delay(1000);
      const after = sentAtMs === undefined
        ? await this.latestTurn(threadId)
        : await this.findTurnAfterDispatch(threadId, beforeTurnId, sentAtMs);
      this.output.appendLine(`[${logPrefix}] verification ${attempt}/12 latest turn: ${after?.id ?? "<none>"}`);
      if (after?.id && after.id !== beforeTurnId) return after;
    }
    return undefined;
  }

  private async verifyNewTurn(threadId: string, beforeTurnId: string | undefined, logPrefix: string): Promise<boolean> {
    const after = await this.waitForNewTurn(threadId, beforeTurnId, logPrefix);
    if (!after) {
      this.output.appendLine(`[${logPrefix}] FAILED: no new turn appeared on the target thread.`);
      return false;
    }
    this.output.appendLine(
      `[${logPrefix}] SUCCESS: a new turn appeared on the same thread (${after.id}); status=${after.status}; error=${formatTurnError(after)}.`,
    );
    return true;
  }

  private async findInterruptedThread(
    limits: RateLimitSnapshot | null,
    rateLimitsAvailable: boolean,
  ): Promise<{ thread: CodexThread; turn: CodexTurn; reason: ArmedResume["reason"] } | undefined> {
    const thread = await this.findMostRecentThread();
    if (!thread) return undefined;

    const ageMinutes = (Date.now() - thread.updatedAt * 1000) / 60_000;
    const recentMinutes = Math.max(
      5,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("recentThreadMinutes", 480),
    );
    if (ageMinutes > recentMinutes) {
      const diagnosticKey = `${thread.id}:${recentMinutes}`;
      if (this.lastStaleThreadDiagnostic !== diagnosticKey) {
        this.lastStaleThreadDiagnostic = diagnosticKey;
        this.output.appendLine(
          `[auto-resume] latest workspace thread ${thread.id} is ${ageMinutes.toFixed(1)} minutes old, outside the ${recentMinutes}-minute arming window`,
        );
      }
      return undefined;
    }
    this.lastStaleThreadDiagnostic = undefined;

    const latest = await this.latestTurn(thread.id);
    this.logObservation(thread, latest, limits);
    if (!latest) return undefined;

    const explicitReason = classifyLimitError(latest);
    if (explicitReason) {
      return { thread, turn: latest, reason: explicitReason };
    }

    const interruptedWithoutStructuredError =
      latest.status === "interrupted" || latest.status === "failed";
    if (!interruptedWithoutStructuredError) return undefined;

    if (rateLimitsAvailable && this.quotaLooksBlocked(limits)) {
      this.output.appendLine(
        `[auto-resume] latest turn is ${latest.status} without a structured usage-limit error, but account rate limits are blocked; treating it as a rate-limit interruption`,
      );
      return { thread, turn: latest, reason: "rateLimitReached" };
    }

    if (!rateLimitsAvailable) {
      const existing = this.pendingQuotaCandidate();
      if (existing?.threadId !== thread.id || existing.turnId !== latest.id) {
        await this.savePendingQuotaCandidate({
          threadId: thread.id,
          cwd: thread.cwd,
          turnId: latest.id,
          observedAtMs: Date.now(),
        });
        this.output.appendLine(
          `[auto-resume] latest turn ${latest.id} is ${latest.status}, but account quota state is unavailable; saved it as a pending quota candidate instead of risking a manual-stop false positive`,
        );
      }
    }

    return undefined;
  }

  private logObservation(
    thread: CodexThread,
    turn: CodexTurn | undefined,
    limits: RateLimitSnapshot | null,
  ): void {
    // Deliberately exclude resetsAt from the dedupe key. The backend often
    // jitters those timestamps by +/-1s even when the actual state is unchanged.
    const observation = stableObservationKey(thread.id, turn, limits);
    if (observation === this.lastObservation) return;
    this.lastObservation = observation;
    this.output.appendLine(
      `[auto-resume] observed thread=${thread.id}; latestTurn=${turn?.id ?? "<none>"}; status=${turn?.status ?? "<none>"}; error=${turn ? formatTurnError(turn) : "none"}; ${formatRateLimits(limits)}`,
    );
  }

  private logResumeObservation(
    armed: ArmedResume,
    turn: CodexTurn | undefined,
    limits: RateLimitSnapshot | null,
  ): void {
    const observation = stableObservationKey(armed.threadId, turn, limits);
    if (observation === this.lastResumeObservation) return;
    this.lastResumeObservation = observation;
    this.output.appendLine(
      `[auto-resume] verifying resume turn=${armed.resumeTurnId}; status=${turn?.status ?? "<not-found>"}; error=${turn ? formatTurnError(turn) : "none"}; ${formatRateLimits(limits)}`,
    );
  }

  private async findMostRecentThread(): Promise<CodexThread | undefined> {
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (folders.length === 0) return undefined;

    const primerThreadId = this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY)?.threadId;
    const recentMinutes = Math.max(
      5,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("recentThreadMinutes", 480),
    );
    const recentCutoffMs = Date.now() - recentMinutes * 60_000;

    const exact = await this.client!.request<ThreadListResponse>("thread/list", {
      limit: 20,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["vscode"],
      cwd: folders,
      archived: false,
    });
    const exactSelected = exact.data.find((thread) => thread.id !== primerThreadId);
    if (exactSelected && exactSelected.updatedAt * 1000 >= recentCutoffMs) {
      this.lastThreadSelectionDiagnostic = undefined;
      return exactSelected;
    }

    // Remote SSH threads can use a cwd below the VS Code workspace root.
    // thread/list cwd filtering is exact-only, so fall back to recent VS Code
    // threads and apply a path-containment check locally.
    const broad = await this.client!.request<ThreadListResponse>("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["vscode"],
      archived: false,
    });
    const workspaceSelected = broad.data.find(
      (thread) =>
        thread.id !== primerThreadId &&
        thread.updatedAt * 1000 >= recentCutoffMs &&
        isThreadCwdInsideWorkspace(thread.cwd, folders),
    );

    if (workspaceSelected) {
      const diagnosticKey = `workspace-fallback:${workspaceSelected.id}:${workspaceSelected.cwd}`;
      if (this.lastThreadSelectionDiagnostic !== diagnosticKey) {
        this.lastThreadSelectionDiagnostic = diagnosticKey;
        this.output.appendLine(
          `[auto-resume] exact workspace cwd lookup was stale or empty; selected recent workspace-descendant thread ${workspaceSelected.id}; cwd=${workspaceSelected.cwd}; source=${formatThreadSource(workspaceSelected.source)}`,
        );
      }
      return workspaceSelected;
    }

    if (!exactSelected && exact.data.length > 0 && primerThreadId) {
      const diagnosticKey = `primer-only:${primerThreadId}:${folders.join("|")}`;
      if (this.lastThreadSelectionDiagnostic !== diagnosticKey) {
        this.lastThreadSelectionDiagnostic = diagnosticKey;
        this.output.appendLine(
          `[auto-resume] ignored dedicated quota-primer thread ${primerThreadId}; no recent workspace Codex thread is available`,
        );
      }
      return undefined;
    }

    if (exactSelected) {
      return exactSelected;
    }

    this.lastThreadSelectionDiagnostic = undefined;
    return undefined;
  }

  private computeResetAt(limits: RateLimitSnapshot | null): number | undefined {
    if (!limits) return undefined;
    const exhausted = [limits.primary, limits.secondary]
      .filter((window): window is NonNullable<typeof window> => Boolean(window))
      .filter((window) => window.usedPercent >= 99)
      .map((window) => window.resetsAt)
      .filter((value): value is number => typeof value === "number" && value * 1000 > Date.now());

    return exhausted.length > 0 ? Math.max(...exhausted) * 1000 : undefined;
  }

  private quotaLooksBlocked(limits: RateLimitSnapshot | null): boolean {
    return classifyQuotaAvailability(this.quotaResponse && { ...this.quotaResponse, rateLimits: limits }).status === "blocked";
  }

  private quotaLooksAvailable(limits: RateLimitSnapshot | null): boolean {
    return classifyQuotaAvailability(this.quotaResponse && { ...this.quotaResponse, rateLimits: limits }).status === "available";
  }

  private resetGraceMs(): number {
    const seconds = Math.max(0, vscode.workspace.getConfiguration("codexAutoResume").get<number>("resetGraceSeconds", 90));
    return seconds * 1000;
  }

  private resumeStabilityMs(): number {
    const seconds = Math.max(
      5,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("resumeStabilitySeconds", 15),
    );
    return seconds * 1000;
  }

  private renderStatus(): void {
    if (!this.enabled()) {
      this.statusBar.text = "$(circle-slash) Codex Resume: Off";
      this.statusBar.tooltip = "Codex Auto Resume is disabled";
      return;
    }
    const armed = this.armed();
    if (!armed) {
      const pending = this.pendingQuotaCandidate();
      if (pending) {
        this.statusBar.text = "$(sync) Codex Resume: Quota Check";
        this.statusBar.tooltip = `Interrupted turn ${pending.turnId} is waiting for account quota confirmation`;
        return;
      }
      this.statusBar.text = "$(eye) Codex Resume: Monitoring";
      this.statusBar.tooltip = "Watching for a Codex usage-limit interruption";
      return;
    }
    if (armed.resumeTurnId || armed.dispatchPending) {
      this.statusBar.text = "$(sync) Codex Resume: Verifying";
      this.statusBar.tooltip = `Continuation ${armed.resumeTurnId ?? "dispatch pending"} is being verified; no duplicate continuation will be sent`;
      return;
    }
    this.statusBar.text = this.availabilityCandidate
      ? "$(sync) Codex Resume: Confirming availability"
      : "$(clock) Codex Resume: Armed (awaiting availability)";
    this.statusBar.tooltip = `Thread ${armed.threadId}; expected backend reset ${new Date(armed.resetAtMs).toLocaleString()}; confirmed quota availability can resume earlier`;

  }
}

function isThreadCwdInsideWorkspace(threadCwd: string, workspaceFolders: string[]): boolean {
  const candidate = normalizeFsPath(threadCwd);
  return workspaceFolders.some((folder) => {
    const root = normalizeFsPath(folder);
    if (candidate === root) return true;
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function normalizeFsPath(value: string): string {
  return path.resolve(value);
}

function formatThreadSource(source: unknown): string {
  if (typeof source === "string") return source;
  try {
    return JSON.stringify(source);
  } catch {
    return "<unknown>";
  }
}

function classifyLimitError(turn: CodexTurn | undefined): ArmedResume["reason"] | undefined {
  const info = turn?.error?.codexErrorInfo;
  if (info === "usageLimitExceeded") return "usageLimitExceeded";
  if (info === "rateLimitExceeded") return "rateLimitExceeded";
  return undefined;
}

function stableObservationKey(
  threadId: string,
  turn: CodexTurn | undefined,
  limits: RateLimitSnapshot | null,
): string {
  return [
    threadId,
    turn?.id ?? "none",
    turn?.status ?? "none",
    turn ? formatTurnError(turn) : "none",
    limits?.rateLimitReachedType ?? "none",
    limits?.primary?.usedPercent ?? "none",
    limits?.secondary?.usedPercent ?? "none",
  ].join("|");
}

function formatTurnError(turn: CodexTurn): string {
  const info = turn.error?.codexErrorInfo;
  if (typeof info === "string") return info;
  if (info) return JSON.stringify(info);
  return turn.error?.message ?? "none";
}

function formatRateLimits(limits: RateLimitSnapshot | null): string {
  if (!limits) return "rateLimits=<none>";
  return [
    `rateLimitReachedType=${limits.rateLimitReachedType ?? "none"}`,
    formatRateLimitWindow("primary", limits.primary),
    formatRateLimitWindow("secondary", limits.secondary),
  ].join("; ");
}

function formatRateLimitWindow(
  name: string,
  window: RateLimitSnapshot["primary"],
): string {
  if (!window) return `${name}=none`;
  const reset = typeof window.resetsAt === "number"
    ? new Date(window.resetsAt * 1000).toISOString()
    : "none";
  return `${name}=${window.usedPercent}% reset=${reset}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
