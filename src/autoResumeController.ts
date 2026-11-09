import * as path from "path";
import { createHash } from "crypto";
import * as vscode from "vscode";
import {
  classifyRecoveryHistory, hasUnambiguousInputProgress, isQuotaFailure, recoveryDiagnostic,
  canManuallyConfirmQuestionContinuation,
  RecoveryPlan, replayText, replayAttachments, UserOnlyPolicy, matchesReplayedInput,
} from "./inputRecovery";
import { readRecoveryHistory } from "./recoveryHistory";
import { buildInteractionTrace, readInteractionTurn } from "./recoveryInteractionTrace";
import { materializePastedTxt, verifyPastedTxtBeforeSend } from "./recoveryAttachments";
import { classifyQuotaAvailability } from "./quotaAvailability";
import { RecoveryCoordinator } from "./recoveryCoordination";
import { RECOVERY_BACKLOG_KEY, enqueueRecovery, readRecoveryBacklog, recoveryQueueSummary, selectNextRecovery } from "./recoveryQueue";
import { isPrimerThread } from "./primerIdentity";
import { readQuotaPrimerSendJournal } from "./quotaPrimerSendJournal";
import { claimWorkResume, readWorkResumeDispatch } from "./workRecoveryDispatch";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import { sendTurnThroughOfficialCodexUi } from "./officialCodexUi";
import { CodexUiIpcRequestError, type CodexTurnStartOverrides } from "./codexUiIpc";
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
const RECOVERY_DECISIONS_KEY = "codexAutoResume.recoveryDecisionHistory";
const MAX_RECOVERY_DECISIONS = 32;

interface RecoveryDecisionRecord {
  observedAtMs: number;
  threadId: string;
  sourceTurnId: string;
  action: "continue" | "replay_input" | "needs_review";
  reason: string;
  preservedInputs: number;
  fingerprint: string;
}
const RESUME_OBSERVATION_POLL_MS = 1_000;
const AVAILABILITY_CONFIRMATION_MS = 10_000;
const AVAILABILITY_CONFIRMATION_TIMEOUT_MS = 30_000;

interface RateLimitReadResult {
  ok: boolean;
  limits: RateLimitSnapshot | null;
}

/** Only thrown before IPC startTurn, when no continuation could have been sent. */
class WorkContinuationPreflightCancelled extends Error {}

export class AutoResumeController implements vscode.Disposable {
  private readonly recovery: RecoveryCoordinator;
  private coordinationUnavailable = false;
  private reviewingInput = false;
  private client?: CodexRpcClient;
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private lifecycleEpoch = 0;
  private tickEpoch?: number;
  private availabilityCandidate?: { threadId: string; armedAtMs: number; observedAtMs: number };
  private lastObservation?: string;
  private lastUnconfirmedLegacyThread?: string;
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
      const reset = armed.resetAtMs > 0 ? new Date(armed.resetAtMs).toLocaleString() : "not provided by the backend";
      void vscode.window.showInformationMessage(
        `Codex Auto Resume enabled and armed for ${armed.threadId}. Expected backend reset ${reset}; the extension will only send when account quota availability is confirmed.`,
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
    await this.saveBacklog([]);
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
    let backlog: ArmedResume[];
    try {
      backlog = this.backlog();
    } catch {
      void vscode.window.showWarningMessage("Saved recovery backlog is invalid. Automatic recovery is blocked; inspect the Codex Auto Resume Output and preserve the workspace state.");
      return;
    }
    const summary = recoveryQueueSummary(armed, backlog);
    const suffix = summary.total > 1
      ? ` Queue: ${summary.total} total; ${summary.ready} awaiting/ready; ${summary.requiresReview} need review; ${summary.verifying} verifying.`
      : "";
    if (!armed) {
      const pending = this.pendingQuotaCandidate();
      if (pending) {
        const reason = pending.reason
          ? `the structured quota error is ${pending.reason}, but an actionable reset time is not yet confirmed`
          : "the quota cause or account status is not yet confirmed";
        void vscode.window.showInformationMessage(
          `Codex Auto Resume preserved interrupted turn ${pending.turnId} on thread ${pending.threadId}; ${reason}. No continuation will be sent until quota availability is independently verified. Workspace credit depletion may require owner action rather than a timed reset.${suffix}`,
        );
        return;
      }
      void vscode.window.showInformationMessage(backlog.length
        ? `Codex Auto Resume has ${backlog.length} saved interrupted conversation(s); no active dispatch. Open the matching Codex editors in this window to allow recovery.${suffix}`
        : "Codex Auto Resume is enabled and monitoring; no interrupted thread is armed.");
      return;
    }
    if (armed.resumeTurnId || armed.dispatchPending) {
      const phase = armed.resumeTurnId ? "verifying a resumed turn" : "checking a pending dispatch";
      const savedAction = armed.recoveryPlan?.action ?? "not yet classified";
      void vscode.window.showInformationMessage(
        `Codex Auto Resume is ${phase} on thread ${armed.threadId}; saved recovery action: ${savedAction}. Review cannot replace an in-flight attempt. No duplicate will be sent. Use Inspect Recovery Input for details.${suffix}`,
      );
      return;
    }
    if (this.inputRecoveryEnabled() && !armed.recoveryPlan) {
      void vscode.window.showInformationMessage(
        `Codex Auto Resume is Armed for thread ${armed.threadId} and classifying the failed input. No recovery action has been chosen; it will not send until classification completes.${suffix}`,
      );
      return;
    }
    if (this.inputRecoveryEnabled() && armed.recoveryPlan?.action === "needs_review") {
      const reason = armed.recoveryPlan.reason;
      const detail = reason.startsWith("attachment_")
        ? "TXT attachment safety/integrity check blocked replay. Inspect the recovery input and restore the original managed attachment; Review cannot bypass this block."
        : "Run Review Recovery Input if the saved input is eligible.";
      void vscode.window.showWarningMessage(
        `Codex Auto Resume saved the recovery target ${armed.threadId}, but input handling needs review (${reason}). ${detail} No continuation will be sent while evidence is unresolved.${suffix}`,
      );
      return;
    }
    const reset = armed.resetAtMs > 0 ? new Date(armed.resetAtMs).toLocaleString() : "unavailable (possibly workspace credit depletion)";
    const action = armed.recoveryPlan?.action === "replay_input"
      ? armed.recoveryPlan.manualReplyKind === "structured_question_reply"
        ? "continue from the last saved structured question answer"
        : "replay the saved input verbatim"
      : "continue existing work";
    void vscode.window.showInformationMessage(
      `Codex Auto Resume is ${this.availabilityCandidate ? "Confirming availability" : "Armed (awaiting availability)"} for thread ${armed.threadId}. Expected backend reset ${reset}; confirmed quota availability can resume earlier. Recovery action: ${action}.${suffix}`,
    );
  }

  /**
   * Passive, metadata-only diagnosis of why a quota-failed conversation was
   * not Armed. Never changes persisted recovery state or sends a message.
   * No raw prompt, question, cwd, credential, log text or full thread ID is
   * included in the user-visible report.
   */
  async diagnoseMonitoring(): Promise<void> {
    const tabs = this.windowConversationIds();
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const hashId = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
    const report: {
      note: string;
      extension: Record<string, unknown>;
      recoveryState: Record<string, unknown>;
      quota: Record<string, unknown>;
      scans: Record<string, unknown>[];
      interpretation: string[];
    } = {
      note: "READ-ONLY METADATA. Does not include user text, full thread IDs or absolute paths. No recovered input is sent or approved.",
      extension: {
        extensionHostPlatform: process.platform,
        remoteName: vscode.env?.remoteName ?? null,
        officialCodexAvailableInThisHost: Boolean(vscode.extensions?.getExtension("openai.chatgpt")),
        workspacesCount: folders.length,
        windowCodexEditorTabs: tabs.size,
        extensionVersion: this.context.extension?.packageJSON?.version ?? "unknown",
        enabled: this.enabled(),
      },
      recoveryState: {
        armed: Boolean(this.armed()),
        pendingQuotaCandidate: Boolean(this.pendingQuotaCandidate()),
        backlogCount: 0,
      },
      quota: { status: "not_checked" },
      scans: [],
      interpretation: [],
    };
    try {
      report.recoveryState.backlogCount = this.backlog().length;
    } catch {
      report.recoveryState.backlog = "invalid_saved_state";
    }
    try {
      await this.ensureClient();
    } catch {
      report.quota = { status: "client_unavailable" };
      report.interpretation.push("The monitoring App Server could not be started on this extension host.");
    }
    if (this.client?.isRunning) {
      try {
        const limits = await this.client.request<RateLimitsReadResponse>(
          "account/rateLimits/read", { excludeResetCreditDetails: true }, 15_000,
        );
        const classified = classifyQuotaAvailability(limits);
        const window = limits.rateLimits;
        report.quota = {
          status: classified.status,
          reason: classified.reason,
          ordinaryUsageAllowed: limits.ordinaryUsageAllowed ?? null,
          reachedType: typeof window?.rateLimitReachedType === "string"
            ? window.rateLimitReachedType : null,
          hasFutureResetTime: Boolean(this.computeResetAt(window)),
        };
        if (classified.status === "blocked" && !this.computeResetAt(window)) {
          report.interpretation.push("Account usage is blocked without a future reset timestamp; a detected interrupted turn should remain saved as Pending, not be silently discarded.");
        }
      } catch {
        report.quota = { status: "unavailable", reason: "rate_limit_read_failed" };
      }
      const modes = [
        { label: "vscode_source", restrictSource: true },
        { label: "all_sources_diagnostic_only", restrictSource: false },
      ];
      for (const mode of modes) {
        const scan: {
          kind: string;
          returned: number;
          workspaceMatches: number;
          visibleTabMatches: number;
          candidates: Record<string, unknown>[];
          error?: string;
        } = {
          kind: mode.label, returned: 0, workspaceMatches: 0,
          visibleTabMatches: 0, candidates: [],
        };
        try {
          const seen = new Set<string>();
          let cursor: string | null = null;
          for (let page = 0; page < 3; page++) {
            const response: ThreadListResponse = await this.client.request<ThreadListResponse>("thread/list", {
              limit: 100, sortKey: "updated_at", sortDirection: "desc", archived: false,
              ...(mode.restrictSource ? { sourceKinds: ["vscode"] } : {}),
              ...(cursor ? { cursor } : {}),
            }, 15_000);
            if (!Array.isArray(response.data)) {
              scan.error = "invalid_thread_list_response";
              break;
            }
            scan.returned += response.data.length;
            for (const thread of response.data) {
              if (!thread || typeof thread.id !== "string" ||
                  typeof thread.cwd !== "string" || !Number.isFinite(thread.updatedAt)) continue;
              const workspaceMatch = isThreadCwdInsideWorkspace(thread.cwd, folders);
              const windowVisible = tabs.has(thread.id.toLowerCase());
              if (workspaceMatch) scan.workspaceMatches++;
              if (windowVisible) scan.visibleTabMatches++;
              if (!workspaceMatch && !windowVisible) continue;
              if (scan.candidates.length >= 20) continue;
              let latestStatus = "not_read";
              let errorCode = "not_read";
              try {
                const turn = await this.latestTurn(thread.id);
                latestStatus = typeof turn?.status === "string" ? turn.status : "missing";
                errorCode = classifyLimitError(turn) ??
                  (typeof turn?.error?.codexErrorInfo === "string"
                    ? "other_structured_error" : turn?.error ? "other_error" : "none");
              } catch {
                latestStatus = "read_failed";
                errorCode = "read_failed";
              }
              scan.candidates.push({
                threadHash: hashId(thread.id),
                workspaceMatch,
                currentWindowEditorTab: windowVisible,
                ageMinutes: Math.max(0, Math.round((Date.now() - thread.updatedAt * 1000) / 60_000)),
                latestStatus,
                structuredQuotaError: errorCode,
              });
            }
            const next = response.nextCursor;
            if (!next || seen.has(next)) break;
            seen.add(next);
            cursor = next;
          }
        } catch {
          scan.error = "thread_list_read_failed";
        }
        report.scans.push(scan);
      }
      const scoped = report.scans[0] as { workspaceMatches?: number };
      const broad = report.scans[1] as { workspaceMatches?: number };
      if (scoped.workspaceMatches === 0 && (broad.workspaceMatches ?? 0) > 0) {
        report.interpretation.push("Recent threads are visible without the vscode source filter but not with it. Confirm exact window ownership before any recovery dispatch.");
      }
      if (report.scans.every(scan => (scan as { workspaceMatches?: number }).workspaceMatches === 0)) {
        report.interpretation.push("No recent App Server conversation matched an open workspace. Check Local/Remote extension hosts, session cwd and the Codex executable/account.");
      }
      if (tabs.size === 0) {
        report.interpretation.push("No window-owned Codex custom-editor tab was found. Sidebar-only sessions cannot be enrolled in the new multi-session backlog without stronger owner evidence.");
      }
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "json", content: JSON.stringify(report, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async resumeNow(): Promise<void> {
    if (this.inputRecoveryEnabled() && this.armed()?.recoveryPlan?.action === "needs_review") {
      await this.reviewRecoveryInput();
      return;
    }
    if (this.armed()?.resumeTurnId || this.armed()?.dispatchPending) {
      void vscode.window.showWarningMessage("A continuation is already being verified. Inspect the exact conversation before attempting another continuation.");
      return;
    }
    if (this.inputRecoveryEnabled() && this.armed()) {
      // In input-aware mode this command must not replace a queued answer with
      // the generic prompt or bypass the independent quota confirmation.
      await this.ensureClient();
      const prepared = await this.prepareRecoveryInput(this.armed()!);
      if (prepared?.recoveryPlan?.action === "needs_review") await this.reviewRecoveryInput();
      else await this.tick();
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
        "[ui-ipc-test] NO OWNER: open the exact target conversation in the Codex sidebar, wait a few seconds, and run the UI IPC bridge test again.",
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

  private backlog(): ArmedResume[] {
    return readRecoveryBacklog(this.context.workspaceState.get<unknown>(RECOVERY_BACKLOG_KEY));
  }

  private async saveBacklog(backlog: ArmedResume[]): Promise<void> {
    await this.context.workspaceState.update(RECOVERY_BACKLOG_KEY, backlog.length ? backlog : undefined);
    await this.syncRecoveryPriority();
  }

  /**
   * Restrict new multi-session candidates to actual Codex editor tabs observed
   * in this VS Code window. A matching cwd alone is never ownership evidence.
   * An unopened/closed thread remains persisted but cannot be auto-dispatched.
   */
  private windowConversationIds(): Set<string> {
    const ids = new Set<string>();
    for (const group of vscode.window.tabGroups?.all ?? []) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputCustom)) continue;
        if (input.viewType !== "chatgpt.conversationEditor" ||
            input.uri.scheme !== "openai-codex" || input.uri.authority !== "route") continue;
        const match = /^\/(?:local|remote)\/([0-9a-f-]{36})$/i.exec(input.uri.path);
        if (match) ids.add(match[1].toLowerCase());
      }
    }
    return ids;
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
      : pending ? { phase: "pending" as const, threadId: pending.threadId }
      : this.backlog()[0] ? { phase: "armed" as const, threadId: this.backlog()[0].threadId }
      : undefined;
    try {
      await this.recovery.set(registration);
      if (this.coordinationUnavailable) this.output.appendLine("[auto-resume] same-host recovery registration recovered");
      this.coordinationUnavailable = false;
    } catch {
      if (!this.coordinationUnavailable) this.output.appendLine("[auto-resume] same-host recovery registration unavailable; work recovery monitoring continues");
      this.coordinationUnavailable = true;
    }
  }

  private inputRecoveryEnabled(): boolean {
    // Turning the feature off must not discard or bypass an already saved input.
    return Boolean(this.armed()?.recoveryPlan) ||
      vscode.workspace.getConfiguration("codexAutoResume").get<boolean>("inputRecovery.enabled", true);
  }

  private userOnlyPolicy(): UserOnlyPolicy {
    return vscode.workspace.getConfiguration("codexAutoResume").get<string>("inputRecovery.userOnlyPolicy", "review") === "replayStableUserOnly"
      ? "replayStableUserOnly" : "review";
  }

  private recoveryDecisionHistory(): RecoveryDecisionRecord[] {
    const value = this.context.workspaceState.get<unknown>(RECOVERY_DECISIONS_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.threadId === "string" &&
      typeof item.reason === "string" && typeof item.action === "string")
      .slice(-MAX_RECOVERY_DECISIONS) as RecoveryDecisionRecord[];
  }

  private async saveRecoveryDecision(threadId: string, plan: RecoveryPlan): Promise<void> {
    const entry: RecoveryDecisionRecord = {
      observedAtMs: Date.now(), threadId, sourceTurnId: plan.sourceTurnId,
      action: plan.action, reason: plan.reason, preservedInputs: plan.inputs.length,
      fingerprint: plan.fingerprint,
    };
    try {
      await this.context.workspaceState.update(RECOVERY_DECISIONS_KEY,
        [...this.recoveryDecisionHistory(), entry].slice(-MAX_RECOVERY_DECISIONS));
    } catch {
      this.output.appendLine("[auto-resume] decision history could not be stored");
    }
  }

  private async prepareRecoveryInput(armed: ArmedResume): Promise<ArmedResume | undefined> {
    if (!this.inputRecoveryEnabled() || armed.dispatchPending || armed.resumeTurnId) return armed;
    const history = await readRecoveryHistory(this.client!, armed.threadId);
    const current = this.armed();
    if (!this.canMonitor() || !current || current.threadId !== armed.threadId ||
        current.armedAtMs !== armed.armedAtMs || current.dispatchPending || current.resumeTurnId) return undefined;
    const latest = history.complete ? history.turns[0] : undefined;
    // User/native continuation already happened. Observe it, do not replay old input.
    if (latest && ["completed", "inProgress"].includes(latest.status)) {
      await this.trackResumeTurn(current, latest);
      const tracked = this.armed();
      if (tracked?.resumeTurnId) await this.checkTrackedResumeAttempt(tracked, null);
      return undefined;
    }
    const changedSource = Boolean(latest && isQuotaFailure(latest) && latest.id !== current.interruptedTurnId);
    const plan = await materializePastedTxt(classifyRecoveryHistory(history, {
      nowMs: Date.now(), previous: current.recoveryPlan, policy: this.userOnlyPolicy(),
      replayAttempts: changedSource ? 0 : current.replayAttempts,
      replaySourceTurnId: latest?.id === current.replayTurnId ? current.replaySourceTurnId : undefined,
    }), current.recoveryPlan);
    const next: ArmedResume = {
      ...current,
      ...(changedSource && latest ? {
        interruptedTurnId: latest.id, reason: latest.error!.codexErrorInfo as ArmedResume["reason"],
        replayAttempts: 0, replaySourceTurnId: undefined, replayTurnId: undefined,
      } : {}),
      recoveryPlan: plan,
      ...(plan.action === "continue" &&
        ["recorded_execution_after_input", "answered_question_followed_by_execution",
          "replayed_input_followed_by_execution"].includes(plan.reason)
        ? { replayAttempts: 0 } : {}),
    };
    const previous = current.recoveryPlan;
    if (changedSource || previous?.fingerprint !== plan.fingerprint || previous.action !== plan.action) {
      this.availabilityCandidate = undefined;
    }
    await this.saveArmed(next);
    if (previous?.fingerprint !== plan.fingerprint || previous.reason !== plan.reason || previous.action !== plan.action) {
      await this.saveRecoveryDecision(next.threadId, plan);
      this.output.appendLine(`[auto-resume] recovery action=${plan.action}; reason=${plan.reason}; sourceTurn=${plan.sourceTurnId || "<unavailable>"}; preservedInputs=${plan.inputs.length}`);
    }
    return this.armed();
  }

  /** Opens a local untitled diagnostic, never logs prompt text or executes a turn. */
  async inspectRecoveryInput(): Promise<void> {
    await this.ensureClient();
    const active = this.armed();
    const backlog = this.backlog();
    const ids = this.windowConversationIds();
    const choices = [...(active ? [active] : []), ...backlog]
      .filter(item => ids.has(item.threadId.toLowerCase()));
    let armed = active;
    if (choices.length > 1 || (!active && choices.length === 1)) {
      const picked = await vscode.window.showQuickPick(choices.map(item => ({
        label: item.threadId,
        description: item.threadId === active?.threadId ? "Current recovery" : "Saved in backlog",
      })), { placeHolder: "Inspect input from which saved Codex conversation?" });
      if (!picked) return;
      armed = choices.find(item => item.threadId === picked.label);
    }
    const threadId = armed?.threadId ?? (await this.findMostRecentThread())?.id;
    if (!threadId) {
      void vscode.window.showWarningMessage("No workspace work thread is available for input inspection.");
      return;
    }
    const history = await readRecoveryHistory(this.client!, threadId);
    const plan = await materializePastedTxt(classifyRecoveryHistory(history, {
      nowMs: Date.now(), previous: armed?.recoveryPlan,
      policy: this.userOnlyPolicy(), replayAttempts: armed?.replayAttempts,
      replaySourceTurnId: history.turns[0]?.id === armed?.replayTurnId ? armed?.replaySourceTurnId : undefined,
    }), armed?.recoveryPlan);
    const report = {
      threadId,
      interpretation: "action/reason below are a fresh history classification using the effective user-only policy; persistedRecovery is the actual saved decision",
      effectiveInputRecoveryEnabled: this.inputRecoveryEnabled(),
      effectiveUserOnlyPolicy: this.userOnlyPolicy(),
      extensionHostPlatform: process.platform,
      remoteName: vscode.env?.remoteName ?? null,
      autoResumeExtensionVersion: this.context.extension?.packageJSON?.version ?? "unknown",
      ...recoveryDiagnostic(plan),
      persistedRecovery: armed ? {
        phase: active?.threadId !== armed.threadId ? "queued"
          : armed.dispatchPending ? "dispatch_pending" : armed.resumeTurnId ? "verifying" : armed.recoveryPlan ? "armed" : "classifying",
        interruptedTurnId: armed.interruptedTurnId,
        action: armed.recoveryPlan?.action ?? null,
        reason: armed.recoveryPlan?.reason ?? null,
        sourceTurnId: armed.recoveryPlan?.sourceTurnId ?? null,
        fingerprint: armed.recoveryPlan?.fingerprint ?? null,
      } : null,
      recentRecoveryDecisions: this.recoveryDecisionHistory().filter(entry => entry.threadId === threadId),
      officialExtensionVersion: vscode.extensions?.getExtension("openai.chatgpt")?.packageJSON?.version ?? "unknown",
    };
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(report, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /**
   * On-demand diagnostic for an exact saved interrupted turn. This method
   * deliberately uses an independent app-server reader: no tick(), quota
   * queries, workspace-state updates, UI writer or recovery classification.
   * It only opens an untitled local report after sanitizing all history data.
   */
  async inspectRecoveryInteractions(): Promise<void> {
    const armed = this.armed();
    // After a user manually continues, the Armed record may be gone. A prior
    // workspace-scoped, metadata-only decision still pins the exact thread
    // and turn, so diagnosis remains possible without another quota outage.
    const lastAmbiguousDecision = this.recoveryDecisionHistory().filter(entry =>
      entry.reason === "unanswered_question_or_approval" &&
      Boolean(entry.threadId) && Boolean(entry.sourceTurnId)).at(-1);
    const threadId = armed?.threadId || lastAmbiguousDecision?.threadId;
    const turnId = armed
      ? (armed.recoveryPlan?.sourceTurnId || armed.interruptedTurnId)
      : lastAmbiguousDecision?.sourceTurnId;
    const targetOrigin = armed ? "current_armed_source" : "historical_saved_ambiguous_decision";
    if (!threadId || !turnId) {
      void vscode.window.showWarningMessage(
        "No saved recovery source turn or prior ambiguous-question decision is available in this extension host. This diagnostic never guesses the latest turn.",
      );
      return;
    }
    let reader: CodexRpcClient | undefined;
    let lookup: Awaited<ReturnType<typeof readInteractionTurn>>;
    // The short-lived reader must never write raw app-server stderr or parse
    // errors into the regular Output channel. Errors become generic status.
    const quietOutput = { appendLine(_line: string) {} } as vscode.OutputChannel;
    try {
      reader = new CodexRpcClient(resolveCodexExecutable(quietOutput), quietOutput);
      await reader.start();
      lookup = await readInteractionTurn(reader, threadId, turnId);
    } catch {
      lookup = { status: "unavailable", pagesRead: 0, turnsScanned: 0 };
    } finally {
      reader?.dispose();
    }
    const report = {
      note: "LOCAL READ-ONLY INTERACTION TRACE. Review locally before sharing. No messages were sent, no approvals were granted and no recovery state was changed.",
      threadId,
      requestedTurnId: turnId,
      targetOrigin,
      extensionHostPlatform: process.platform,
      remoteName: vscode.env?.remoteName ?? null,
      autoResumeExtensionVersion: this.context.extension?.packageJSON?.version ?? "unknown",
      officialExtensionVersion: vscode.extensions?.getExtension("openai.chatgpt")?.packageJSON?.version ?? "unknown",
      source: {
        status: lookup.status, pagesRead: lookup.pagesRead,
        turnsScanned: lookup.turnsScanned,
      },
      ...(lookup.turn ? { trace: buildInteractionTrace(lookup.turn) } : {}),
      recoveryStateNote: "Read-only workspace recovery metadata was used solely to identify the exact source turn. Armed state, approvals, dispatch claims and quotas were not modified; no message was sent.",
    };
    const doc = await vscode.workspace.openTextDocument({
      language: "json", content: JSON.stringify(report, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * The review target is chosen explicitly from the window's saved backlog.
   * Never switch away from a dispatch that could already have been delivered.
   */
  private async selectRecoveryForReview(): Promise<boolean> {
    const backlog = this.backlog();
    if (!backlog.length) return true;
    const current = this.armed();
    if (current?.dispatchPending || current?.resumeTurnId) {
      void vscode.window.showWarningMessage("An existing recovery dispatch is being verified; selection is blocked until its outcome is known.");
      return false;
    }
    const ids = this.windowConversationIds();
    const choices = [...(current ? [current] : []), ...backlog]
      .filter(item => ids.has(item.threadId.toLowerCase()));
    if (!choices.length) {
      void vscode.window.showWarningMessage("No saved recovery conversation is open in this VS Code window.");
      return false;
    }
    const selected = await vscode.window.showQuickPick(choices.map(item => ({
      label: item.threadId,
      description: item.recoveryPlan?.action === "needs_review" ? "Review required" : "Recovery queued",
      threadId: item.threadId,
    })), { placeHolder: "Select a conversation in this window to review its saved input" });
    if (!selected) return false;
    if (current?.threadId === selected.threadId) return true;
    const target = backlog.find(item => item.threadId === selected.threadId);
    if (!target) return false;
    // Save the outgoing active record in the backlog before replacing it.
    const nextBacklog = [...backlog.filter(item => item.threadId !== target.threadId &&
      item.threadId !== current?.threadId), ...(current ? [current] : [])];
    await this.saveBacklog(nextBacklog);
    await this.saveArmed(target);
    this.availabilityCandidate = undefined;
    return true;
  }

  /** An explicit per-input choice queues an action; it never bypasses quota guards. */
  async reviewRecoveryInput(): Promise<void> {
    if (this.reviewingInput) return;
    if (!this.inputRecoveryEnabled()) {
      void vscode.window.showWarningMessage("Enable input-aware recovery before reviewing a saved input.");
      return;
    }
    this.reviewingInput = true;
    try {
      await this.ensureClient();
      if (!await this.selectRecoveryForReview()) return;
      const armed = this.armed();
      if (!armed) {
        void vscode.window.showWarningMessage("There is no Armed recovery target in this extension host. Inspect the current conversation or confirm the Local/Remote host.");
        return;
      }
      if (armed.resumeTurnId || armed.dispatchPending) {
        const phase = armed.resumeTurnId ? "verifying a resumed turn" : "checking a pending dispatch";
        void vscode.window.showWarningMessage(
          `Recovery on thread ${armed.threadId} is ${phase}; it cannot be replaced by Review. Use Inspect Recovery Input to see persistedRecovery and the saved action.`,
        );
        return;
      }
      const prepared = await this.prepareRecoveryInput(armed);
      const plan = prepared?.recoveryPlan;
      if (!plan) return;
      const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify({
        note: "LOCAL INPUT PREVIEW. This untitled document contains user input. Do not upload it without reviewing it for secrets. Edits here do not change the saved input.",
        threadId: armed.threadId, action: plan.action, reason: plan.reason, inputs: plan.inputs,
        pastedTxtAttachment: plan.attachmentIntegrity ?? null,
        attachmentSha256: plan.pastedTxtSnapshots?.map(item => item.sha256) ?? [],
        noteOnTxt: "Verified TXT content is retained and sent as a separate native UI attachment; the original prompt remains unchanged.",
      }, null, 2) });
      await vscode.window.showTextDocument(document, { preview: true });
      const historical = plan.reason === "unanswered_question_or_approval"
        ? await readRecoveryHistory(this.client!, armed.threadId) : null;
      const manualQuestionContinue = !plan.stale && plan.reason === "unanswered_question_or_approval" &&
        historical?.complete === true && plan.inputs.length === 1 && historical.turns.length >= 1 &&
        historical.turns[0].id === plan.sourceTurnId &&
        canManuallyConfirmQuestionContinuation(historical.turns[0]);
      const manualLateAnswer = !plan.stale && plan.reason === "multiple_unresolved_inputs" &&
        plan.candidate === "replay_input" && Boolean(plan.manualReplayInput) &&
        !plan.manualReplyKind && replayText(plan) !== undefined;
      const manualStructuredAnswer = !plan.stale && plan.reason === "multiple_unresolved_inputs" &&
        plan.candidate === "replay_input" && plan.manualReplyKind === "structured_question_reply" &&
        Boolean(plan.manualReplayInput) && replayText(plan) !== undefined;
      if (!manualQuestionContinue && !manualLateAnswer && !manualStructuredAnswer &&
          (plan.stale || plan.candidate !== "replay_input" || replayText(plan) === undefined)) {
        const detail = plan.reason.startsWith("attachment_")
          ? `TXT attachment is blocked by ${plan.reason}; fix or restore the original file in the same host. Review cannot waive attachment integrity checks.`
          : "The input is incomplete, unsupported, multiple, oversized, or has an unresolved interaction that cannot safely be replayed.";
        if (plan.reason === "multiple_unresolved_inputs") {
          const inspect = "Inspect question/approval evidence (read-only)";
          const selected = await vscode.window.showWarningMessage(
            `Recovery has ${plan.inputs.length} saved user inputs, but this history does not prove a safe final reply to resume. ${detail} No recovery was sent. You can inspect the exact recorded interaction evidence without changing recovery state.`,
            { modal: true }, inspect,
          );
          if (selected === inspect) await this.inspectRecoveryInteractions();
        } else {
          void vscode.window.showWarningMessage(`${detail} Nothing was sent.`);
        }
        return;
      }
      const replay = "Replay saved input after quota recovery";
      const replayLatest = "Replay latest saved answer only after quota recovery";
      const continueFromStructured = "Continue using last saved question answer after quota recovery";
      const proceed = "Continue existing work after quota recovery";
      const choice = manualStructuredAnswer
        ? await vscode.window.showWarningMessage(
          "The quota-failed turn contains several native question replies. Prior work exists, but the final answer has no recorded Codex acknowledgement. The official UI IPC cannot resend a native question-reply envelope as such. After reviewing the saved inputs and confirming the last answer, choose Continue to send a NEW ordinary-text continuation explicitly quoting only the final question and answer; earlier work and answers will not be replayed. No new tool permissions or broader authorization are granted.",
          { modal: true }, continueFromStructured)
        : manualLateAnswer
        ? await vscode.window.showWarningMessage(
          "The original task already performed work, but the final ordinary-text reply has no confirmed execution afterwards. After inspecting this conversation, you may replay ONLY that final reply. The original task and earlier messages will not be resent. This does not grant a permission or resolve a pending approval.",
          { modal: true }, replayLatest)
        : manualQuestionContinue
        ? await vscode.window.showWarningMessage(
          "History contains an ambiguous question, but this turn has executed work. Only if you personally verified that no answer or approval is still pending, choose Continue. This sends the configured continuation prompt once after quota recovery and grants NO new permissions; the original prompt and its attachments will NOT be resent.",
          { modal: true }, proceed)
        : await vscode.window.showWarningMessage(
          "Full history contains one user input but cannot prove whether it started. Choose only after checking the original conversation. This queues one exact action, not additional execution permissions.",
          { modal: true }, replay, proceed,
        );
      if (choice !== replay && choice !== replayLatest &&
          choice !== continueFromStructured && choice !== proceed) return;
      const fresh = await readRecoveryHistory(this.client!, armed.threadId);
      const check = await materializePastedTxt(classifyRecoveryHistory(fresh, { nowMs: Date.now(), previous: plan,
        replaySourceTurnId: fresh.turns[0]?.id === prepared?.replayTurnId ? prepared?.replaySourceTurnId : undefined,
      }), plan);
      const current = this.armed();
      const revalidatedManualQuestion = manualQuestionContinue && choice === proceed &&
        fresh.complete && fresh.turns.length >= 1 &&
        fresh.turns[0].id === plan.sourceTurnId &&
        canManuallyConfirmQuestionContinuation(fresh.turns[0]) &&
        check.reason === "unanswered_question_or_approval";
      const revalidatedStructuredAnswer = manualStructuredAnswer && choice === continueFromStructured &&
        !check.stale && check.reason === "multiple_unresolved_inputs" &&
        check.candidate === "replay_input" && check.manualReplyKind === "structured_question_reply" &&
        replayText(check) === replayText(plan) && replayText(check) !== undefined &&
        check.manualReplayInput?.turnId === plan.manualReplayInput?.turnId &&
        check.manualReplayInput?.messageId === plan.manualReplayInput?.messageId;
      const revalidatedLateAnswer = manualLateAnswer && choice === replayLatest &&
        !check.stale && check.reason === "multiple_unresolved_inputs" &&
        check.candidate === "replay_input" && replayText(check) !== undefined &&
        check.manualReplayInput?.turnId === plan.manualReplayInput?.turnId &&
        check.manualReplayInput?.messageId === plan.manualReplayInput?.messageId;
      const revalidatedReplay = !manualQuestionContinue && !manualLateAnswer &&
        check.candidate === "replay_input" && !check.stale && replayText(check) !== undefined;
      if (!this.canMonitor() || !current || current.armedAtMs !== armed.armedAtMs ||
          current.threadId !== armed.threadId || current.dispatchPending || current.resumeTurnId ||
          !fresh.complete || check.fingerprint !== plan.fingerprint ||
          !(revalidatedManualQuestion || revalidatedLateAnswer ||
            revalidatedStructuredAnswer || revalidatedReplay) ||
          current.recoveryPlan?.fingerprint !== plan.fingerprint) {
        void vscode.window.showWarningMessage("Recovery changed while the dialog was open. The stale choice was not applied; review the latest input.");
        return;
      }
      const action = choice === replay || choice === replayLatest ||
        choice === continueFromStructured ? "replay_input" as const : "continue" as const;
      const approved: RecoveryPlan = {
        ...check, action,
        ...(manualQuestionContinue ? { candidate: "continue" as const } : {}),
        reason: manualQuestionContinue
          ? "user_confirmed_ambiguous_question_continue" : revalidatedLateAnswer
          ? "user_confirmed_latest_answer_replay" : revalidatedStructuredAnswer
          ? "user_confirmed_last_structured_answer_continue" : "user_confirmed_action",
        approval: { action, fingerprint: check.fingerprint },
      };
      await this.saveArmed({ ...current, recoveryPlan: approved, replayAttempts: 0 });
      await this.saveRecoveryDecision(current.threadId, approved);
      this.availabilityCandidate = undefined;
      this.renderStatus();
      void vscode.window.showInformationMessage(`Saved recovery action: ${action}. Two fresh available-quota reads are still required; nothing was sent by this command.`);
    } finally {
      this.reviewingInput = false;
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
      let armed = this.armed();
      // A review-blocked conversation must not starve other safe conversations.
      // The old active record remains byte-for-byte intact in the backlog.
      const ids = this.windowConversationIds();
      const backlog = this.backlog();
      if (!armed || (armed.recoveryPlan?.action === "needs_review" &&
                     !armed.dispatchPending && !armed.resumeTurnId)) {
        const eligible = backlog.filter(item => ids.has(item.threadId.toLowerCase()) &&
          item.recoveryPlan?.action !== "needs_review");
        const chosen = selectNextRecovery(eligible, true);
        if (chosen) {
          const nextBacklog = backlog.filter(item => item.threadId !== chosen.selected.threadId &&
            item.threadId !== armed?.threadId);
          if (armed) nextBacklog.push(armed);
          if (armed) {
            await this.saveBacklog(nextBacklog);
            await this.saveArmed(chosen.selected);
          } else {
            // Write the new active record before removing the durable backlog
            // copy. A crash may leave a duplicate, but can never lose the job.
            await this.saveArmed(chosen.selected);
            await this.saveBacklog(nextBacklog);
          }
          armed = chosen.selected;
        }
      }
      const pendingIdentity = this.pendingQuotaCandidate();
      const armedIsPrimer = armed && await this.isRecordedPrimerThread(armed.threadId);
      const pendingIsPrimer = pendingIdentity && await this.isRecordedPrimerThread(pendingIdentity.threadId);
      if (armedIsPrimer || pendingIsPrimer) {
        if (!this.canMonitor()) return;
        this.availabilityCandidate = undefined;
        if (armedIsPrimer) await this.saveArmed(undefined);
        if (pendingIsPrimer) await this.savePendingQuotaCandidate(undefined);
        this.output.appendLine("[auto-resume] cleared a stored Primer recovery target; dedicated Primer threads are excluded from work recovery");
        return;
      }

      if (armed && this.backlog().length && vscode.window.tabGroups &&
          !ids.has(armed.threadId.toLowerCase())) {
        // The shared workspace store can be read by another VS Code window
        // opening the same folder. Never dispatch another window's saved work.
        // Its owner window can still progress it. We may discover this window's
        // other custom-editor conversations into the backlog.
        this.availabilityCandidate = undefined;
        await this.collectWindowRecoveries(limits);
        return;
      }

      if (armed?.resumeTurnId) {
        this.availabilityCandidate = undefined;
        await this.checkTrackedResumeAttempt(armed, limits);
      } else if (armed?.dispatchPending) {
        this.availabilityCandidate = undefined;
        await this.checkPendingDispatch(armed);
      } else if (armed) {
        const prepared = await this.prepareRecoveryInput(armed);
        if (prepared) await this.checkAvailabilityForResume(prepared, limits);
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
      if (this.canMonitor()) await this.collectWindowRecoveries(limits);
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
      return "pending"; // A stale/paginated history is not evidence that this exact target vanished.
    }

    const explicitReason = candidate.reason ?? classifyLimitError(turn);
    const interrupted = turn.status === "interrupted" || turn.status === "failed";
    if (explicitReason && candidate.reason !== explicitReason) {
      await this.savePendingQuotaCandidate({ ...candidate, reason: explicitReason });
    }
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

    const reason = explicitReason;
    if (!reason) {
      if (this.quotaLooksAvailable(limits)) {
        this.output.appendLine(
          `[auto-resume] pending interrupted turn ${candidate.turnId} was not confirmed as quota-related once account state recovered; clearing it without resuming`,
        );
        await this.savePendingQuotaCandidate(undefined);
        return "cleared";
      }
      // Account blocking can coincide with a manual Stop. Keep observing this
      // exact turn until its own structured error proves the interruption cause.
      return "pending";
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
    if (this.inputRecoveryEnabled() && (!armed.recoveryPlan || armed.recoveryPlan.action === "needs_review")) {
      this.availabilityCandidate = undefined;
      return;
    }
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
    if (current.windowScoped && !this.windowConversationIds().has(current.threadId.toLowerCase())) {
      this.output.appendLine(`[auto-resume] window-scoped thread ${current.threadId} is no longer open here; preserving recovery without IPC`);
      return;
    }
    if (this.inputRecoveryEnabled() && (!current.recoveryPlan || current.recoveryPlan.action === "needs_review")) return;
    const savedInput = current.recoveryPlan?.action === "replay_input" ? replayText(current.recoveryPlan) : undefined;
    if (current.recoveryPlan?.action === "replay_input" && savedInput === undefined) return;
    const pastedTxtAttachments = savedInput !== undefined && current.recoveryPlan?.action === "replay_input"
      ? replayAttachments(current.recoveryPlan) : undefined;
    if (savedInput !== undefined && pastedTxtAttachments === undefined) return;
    const uiOverrides: CodexTurnStartOverrides = pastedTxtAttachments && pastedTxtAttachments.length > 0
      ? { attachments: pastedTxtAttachments } : {};
    const prompt = savedInput ?? this.resumePrompt();
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
    if (armed.reason === "rateLimitReached" && !classifyLimitError(before)) {
      if (this.lastUnconfirmedLegacyThread !== armed.threadId) {
        this.output.appendLine(`[auto-resume] retaining legacy armed thread ${armed.threadId}; its structured quota cause must be confirmed before automatic continuation`);
        this.lastUnconfirmedLegacyThread = armed.threadId;
      }
      return;
    }
    this.lastUnconfirmedLegacyThread = undefined;
    if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    const claim = await claimWorkResume(this.context.globalStorageUri.fsPath, {
      threadId: armed.threadId, beforeTurnId: before.id, sentAtMs: Date.now(),
    });
    const pending: ArmedResume = {
      ...armed,
      replayAttempts: savedInput !== undefined && claim.status === "claimed"
        ? (armed.replayAttempts ?? 0) + 1 : armed.replayAttempts,
      dispatchPending: { beforeTurnId: claim.record.beforeTurnId, sentAtMs: claim.record.sentAtMs, hostClaimToken: claim.record.token },
    };
    // Both the host claim and workspace intent precede transport. Other
    // windows adopt this exact attempt, even after its owner crashes.
    try {
      await this.saveArmed(pending);
    } catch (error) {
      if (claim.status === "claimed") await claim.releaseUnsent();
      throw error;
    }
    if (!this.canMonitor() || !this.armed()?.dispatchPending) {
      if (claim.status === "claimed") await claim.releaseUnsent();
      return;
    }
    this.renderStatus();
    if (claim.status === "existing") {
      this.output.appendLine(`[auto-resume] adopting the same-host pending continuation for ${armed.threadId}; no duplicate will be sent`);
      return;
    }
    if (uiOverrides.attachments?.length) {
      this.output.appendLine(
        `[auto-resume] replaying original input with ${uiOverrides.attachments.length} verified pasted TXT attachment(s) through official UI context; prompt body unchanged`,
      );
    }
    let sent: boolean;
    try {
      sent = await this.sendThroughOfficialUi(armed.threadId, prompt, "auto-resume", async () => {
        // Owner discovery and editor mounting are asynchronous. The user may
        // disable Auto Resume or manually continue the exact conversation while
        // we are finding the official writer. Recheck immediately before IPC
        // startTurn instead of relying on the earlier dispatch snapshot.
        const currentAttempt = this.armed();
        if (currentAttempt?.windowScoped && !this.windowConversationIds().has(armed.threadId.toLowerCase())) {
          throw new WorkContinuationPreflightCancelled("window-scoped conversation moved or closed before delivery");
        }
        if (!this.canMonitor() || !currentAttempt?.dispatchPending ||
            currentAttempt.threadId !== armed.threadId ||
            currentAttempt.dispatchPending.hostClaimToken !== claim.record.token ||
            currentAttempt.dispatchPending.beforeTurnId !== before.id) {
          throw new WorkContinuationPreflightCancelled("recovery state changed during owner discovery");
        }
        // A read failing inside this guard is known-unsent, not ambiguous IPC delivery.
        let latest: CodexTurn | undefined;
        try {
          latest = await this.latestTurn(armed.threadId);
          if (this.inputRecoveryEnabled()) {
            const history = await readRecoveryHistory(this.client!, armed.threadId);
            const checked = await materializePastedTxt(classifyRecoveryHistory(history, {
              nowMs: Date.now(), previous: armed.recoveryPlan, policy: this.userOnlyPolicy(),
              replayAttempts: armed.replayAttempts,
              replaySourceTurnId: history.turns[0]?.id === armed.replayTurnId ? armed.replaySourceTurnId : undefined,
            }), armed.recoveryPlan);
            if (!history.complete || checked.stale || checked.fingerprint !== armed.recoveryPlan?.fingerprint ||
                checked.action !== armed.recoveryPlan.action || checked.action === "needs_review" ||
                (checked.action === "replay_input" && (
                  replayText(checked) !== prompt ||
                  !await verifyPastedTxtBeforeSend(checked) ||
                  JSON.stringify(replayAttachments(checked)) !== JSON.stringify(pastedTxtAttachments)))) {
              throw new Error("recovery evidence changed");
            }
          }
        } catch {
          throw new WorkContinuationPreflightCancelled("input evidence changed or became unavailable before delivery");
        }
        if (!this.canMonitor() || this.armed()?.dispatchPending?.hostClaimToken !== claim.record.token ||
            !latest || latest.id !== before.id ||
            (latest.status !== "failed" && latest.status !== "interrupted")) {
          throw new WorkContinuationPreflightCancelled("work conversation changed during owner discovery");
        }
      }, uiOverrides);
    } catch (error) {
      // Unsupported/invalid attachment metadata is rejected before the IPC
      // start-turn request; release only this definitely-unsent claim and keep
      // the saved input for manual handling instead of retrying every poll.
      if (error instanceof CodexUiIpcRequestError &&
          ["pasted-text-attachments-unsupported", "invalid-pasted-text-attachment"].includes(error.code)) {
        await claim.releaseUnsent();
        if (this.canMonitor() && this.armed()?.dispatchPending?.hostClaimToken === claim.record.token) {
          const oldPlan = pending.recoveryPlan;
          await this.saveArmed({
            ...pending,
            recoveryPlan: oldPlan ? {
              ...oldPlan, action: "needs_review",
              reason: error.code === "pasted-text-attachments-unsupported"
                ? "pasted_txt_attachment_protocol_unsupported" : "pasted_txt_attachment_metadata_invalid",
              approval: undefined, stale: true,
            } : oldPlan,
            replayAttempts: armed.replayAttempts,
            dispatchPending: undefined,
          });
        }
        this.output.appendLine(`[auto-resume] blocked TXT attachment replay for ${armed.threadId}: ${error.code}; saved input remains for review`);
        return;
      }
      // A failed pre-send guard proves startTurn was never called. Other IPC
      // exceptions are ambiguous and must retain the durable dispatch claim.
      if (!(error instanceof WorkContinuationPreflightCancelled)) throw error;
      await claim.releaseUnsent();
      if (this.canMonitor() && this.armed()?.dispatchPending?.hostClaimToken === claim.record.token) {
        await this.saveArmed({ ...pending, replayAttempts: armed.replayAttempts, dispatchPending: undefined });
      }
      this.output.appendLine(`[auto-resume] cancelled unsent continuation for ${armed.threadId}: ${error.message}; no duplicate will be submitted without fresh confirmation`);
      return;
    }
    if (!sent) {
      await claim.releaseUnsent();
      if (this.canMonitor() && this.armed()?.dispatchPending?.sentAtMs === pending.dispatchPending!.sentAtMs) {
        const deferred: ArmedResume = { ...pending, replayAttempts: armed.replayAttempts, dispatchPending: undefined };
        const ids = this.windowConversationIds();
        const backlog = this.backlog();
        const anotherReady = backlog.some(item => ids.has(item.threadId.toLowerCase()) &&
          item.threadId !== armed.threadId && item.recoveryPlan?.action !== "needs_review" &&
          !item.dispatchPending && !item.resumeTurnId);
        if (anotherReady) {
          // Definitive no-owner is known-unsent. Yield so another independent
          // conversation can proceed, but do not drop the original recovery.
          await this.saveBacklog([...backlog.filter(item => item.threadId !== armed.threadId), deferred]);
          await this.saveArmed(undefined);
          this.output.appendLine(`[auto-resume] no UI owner for ${armed.threadId}; deferred it behind another window-visible recovery`);
        } else {
          await this.saveArmed(deferred);
          this.output.appendLine(`[auto-resume] no active UI owner for ${armed.threadId}; keeping thread armed for a confirmed retry`);
        }
      }
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
    const pending = armed.dispatchPending!;
    if (pending.hostClaimToken && pending.beforeTurnId) {
      const host = await readWorkResumeDispatch(this.context.globalStorageUri.fsPath, {
        threadId: armed.threadId, beforeTurnId: pending.beforeTurnId,
      });
      if (!this.canMonitor() || this.armed()?.dispatchPending?.hostClaimToken !== pending.hostClaimToken) return;
      if (!host) {
        await this.saveArmed({ ...armed, dispatchPending: undefined });
        this.output.appendLine("[auto-resume] same-host continuation was definitively not sent; returning to fresh availability confirmation");
        return;
      }
      if (host.token !== pending.hostClaimToken) {
        armed = { ...armed, dispatchPending: { beforeTurnId: host.beforeTurnId, sentAtMs: host.sentAtMs, hostClaimToken: host.token } };
        await this.saveArmed(armed);
      }
    }
    const turn = await this.findTurnAfterDispatch(armed.threadId, armed.dispatchPending!.beforeTurnId, armed.dispatchPending!.sentAtMs);
    if (!turn) return;
    await this.trackResumeTurn(armed, turn);
    const tracking = this.armed();
    if (tracking?.resumeTurnId) await this.checkTrackedResumeAttempt(tracking, null);
  }

  private async trackResumeTurn(armed: ArmedResume, turn: CodexTurn): Promise<void> {
    if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    let ownReplay = false;
    if (this.inputRecoveryEnabled() && armed.dispatchPending && armed.recoveryPlan?.action === "replay_input") {
      const history = await readRecoveryHistory(this.client!, armed.threadId);
      const observed = history.turns.find(item => item.id === turn.id);
      ownReplay = Boolean(history.complete && observed && matchesReplayedInput(observed, armed.recoveryPlan));
      if (!this.canMonitor() || this.armed()?.armedAtMs !== armed.armedAtMs) return;
    }
    await this.saveArmed({
      ...armed, dispatchPending: undefined, resumeTurnId: turn.id,
      ...(ownReplay ? {
        replaySourceTurnId: armed.recoveryPlan!.sourceTurnId, replayTurnId: turn.id,
      } : {}),
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

    if (this.inputRecoveryEnabled() && ["completed", "interrupted", "failed"].includes(turn.status)) {
      const latest = await this.latestTurn(armed.threadId);
      if (!this.canMonitor() || this.armed()?.resumeTurnId !== resumeTurnId) return "pending";
      if (latest && latest.id !== resumeTurnId && isQuotaFailure(latest)) {
        // A new answer can fail while the preceding attempt is being verified.
        // Retain this same conversation rather than disarm and rediscover an
        // unrelated, more recently updated workspace conversation.
        const next: ArmedResume = { ...armed, resumeTurnId: undefined,
          resumeStartedAtMs: undefined, resumeInProgressSinceMs: undefined,
          interruptedTurnId: latest.id, reason: latest.error!.codexErrorInfo as ArmedResume["reason"],
          recoveryPlan: armed.recoveryPlan ? { ...armed.recoveryPlan, stale: true, approval: undefined,
            action: "needs_review", reason: "new_input_after_verified_turn" } : undefined,
          replayAttempts: 0, replaySourceTurnId: undefined, replayTurnId: undefined, dispatchPending: undefined,
        };
        await this.saveArmed(next);
        await this.prepareRecoveryInput(next);
        return "rearmed";
      }
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
        recoveryPlan: armed.recoveryPlan ? { ...armed.recoveryPlan,
          action: "needs_review", candidate: undefined, stale: true, approval: undefined,
          reason: "reclassify_after_quota_failure",
        } : undefined, // Retain saved input until fresh history replaces it.
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

    if (turn.status === "inProgress" && this.inputRecoveryEnabled()) {
      const history = await readRecoveryHistory(this.client!, armed.threadId);
      if (!this.canMonitor() || this.armed()?.resumeTurnId !== resumeTurnId) return "pending";
      const detailed = history.turns.find(item => item.id === resumeTurnId);
      if (!history.complete || !detailed || !hasUnambiguousInputProgress(detailed)) {
        if (armed.resumeInProgressSinceMs !== undefined) await this.saveArmed({ ...armed, resumeInProgressSinceMs: undefined });
        return "pending"; // A lifecycle allocation is not execution evidence.
      }
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

  private async sendThroughOfficialUi(
    threadId: string,
    prompt: string,
    logPrefix: string,
    beforeStartTurn?: () => Promise<void>,
    overrides: CodexTurnStartOverrides = {},
  ): Promise<boolean> {
    return sendTurnThroughOfficialCodexUi(threadId, prompt, this.output, logPrefix, overrides, beforeStartTurn);
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

  /**
   * Window-local discovery only. A thread/list result is a workspace match,
   * never enough by itself to identify the window that owns the conversation.
   */
  private async collectWindowRecoveries(limits: RateLimitSnapshot | null): Promise<void> {
    const windowIds = this.windowConversationIds();
    if (!windowIds.size) return;
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    if (!folders.length) return;
    const queued = new Set(this.backlog().map(item => item.threadId.toLowerCase()));
    if (this.armed()) queued.add(this.armed()!.threadId.toLowerCase());
    const primerState = this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY);
    const journalRead = await readQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath);
    const journal = journalRead.status === "ready" ? journalRead.journal : undefined;
    const primerIds = [...(journal?.knownPrimerThreadIds ?? []), ...(journal?.threadId ? [journal.threadId] : [])];
    const recentCutoff = Date.now() - Math.max(5,
      vscode.workspace.getConfiguration("codexAutoResume").get<number>("recentThreadMinutes", 480)) * 60_000;
    // Only when a current-window editor gives exact ID evidence may we
    // widen the source filter. Some Remote SSH Codex clients do not report
    // their conversations as sourceKinds=["vscode"].
    for (const filterSource of [true, false]) {
      if ([...windowIds].every(id => queued.has(id))) break;
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const response: ThreadListResponse = await this.client!.request<ThreadListResponse>("thread/list", {
          limit: 100, sortKey: "updated_at", sortDirection: "desc",
          ...(filterSource ? { sourceKinds: ["vscode"] } : {}),
          archived: false, ...(cursor ? { cursor } : {}),
        });
      if (!Array.isArray(response?.data)) return;
      for (const thread of response.data) {
        if (!thread || !windowIds.has(thread.id.toLowerCase()) ||
            queued.has(thread.id.toLowerCase()) ||
            !isThreadCwdInsideWorkspace(thread.cwd, folders) ||
            !Number.isFinite(thread.updatedAt) ||
            thread.updatedAt * 1000 < recentCutoff ||
            isPrimerThread(thread, primerState, primerIds)) continue;
        const latest = await this.latestTurn(thread.id);
        const reason = classifyLimitError(latest);
        if (!latest || !reason || !this.canMonitor()) continue;
        const record: ArmedResume = {
          threadId: thread.id, cwd: thread.cwd, armedAtMs: Date.now(), windowScoped: true,
          resetAtMs: this.computeResetAt(limits) ?? 0,
          interruptedTurnId: latest.id, reason,
        };
        // This classification is persisted independently for each source;
        // unknown input evidence must remain needs_review.
        const history = await readRecoveryHistory(this.client!, thread.id);
        record.recoveryPlan = await materializePastedTxt(classifyRecoveryHistory(history, {
          nowMs: Date.now(), policy: this.userOnlyPolicy(),
        }));
        if (!this.canMonitor()) return;
        const current = this.backlog();
        const next = enqueueRecovery(current, record, this.armed()?.threadId);
        if (next.length !== current.length) {
          await this.saveBacklog(next);
          queued.add(thread.id.toLowerCase());
          this.output.appendLine(`[auto-resume] saved window-visible quota-failed thread ${thread.id}; action=${record.recoveryPlan.action}`);
        }
      }
      const nextCursor: string | null = response.nextCursor;
        if (!nextCursor || seen.has(nextCursor)) break;
        cursor = nextCursor;
        seen.add(nextCursor);
      }
    }
  }

  private async findInterruptedThread(
    limits: RateLimitSnapshot | null,
    rateLimitsAvailable: boolean,
  ): Promise<{ thread: CodexThread; turn: CodexTurn; reason: ArmedResume["reason"] } | undefined> {
    const thread = await this.findMostRecentThread();
    if (!thread) return undefined;
    // Existing single-target monitoring remains compatible with official
    // sidebar-only Codex sessions (which may not expose any custom editor tab).
    // When THIS window does have Codex editor tabs, never select a different
    // window's recent thread merely because it shares the workspace cwd.
    const localTabs = this.windowConversationIds();
    if (vscode.window.tabGroups && localTabs.size > 0 && !localTabs.has(thread.id.toLowerCase())) {
      return undefined;
    }

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

    if (!rateLimitsAvailable || this.quotaLooksBlocked(limits)) {
      const existing = this.pendingQuotaCandidate();
      if (existing?.threadId !== thread.id || existing.turnId !== latest.id) {
        await this.savePendingQuotaCandidate({
          threadId: thread.id,
          cwd: thread.cwd,
          turnId: latest.id,
          observedAtMs: Date.now(),
        });
        this.output.appendLine(
          `[auto-resume] latest turn ${latest.id} is ${latest.status}, and its quota cause is unconfirmed; saved it as a pending quota candidate instead of risking a manual-stop false positive`,
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

  private async isRecordedPrimerThread(threadId: string): Promise<boolean> {
    const state = this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY);
    const host = await readQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath);
    const journal = host.status === "ready" ? host.journal : undefined;
    return isPrimerThread({ id: threadId } as CodexThread, state, [
      ...(journal?.knownPrimerThreadIds ?? []), ...(journal?.threadId ? [journal.threadId] : []),
      ...(journal?.pending ? [journal.pending.threadId] : []),
    ]);
  }

  private async findMostRecentThread(): Promise<CodexThread | undefined> {
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    if (!folders.length) return undefined;
    const primerState = this.context.globalState.get<QuotaPrimerState>(QUOTA_PRIMER_STATE_KEY);
    const hostState = await readQuotaPrimerSendJournal(this.context.globalStorageUri.fsPath);
    // Coordination failures cannot stop work observation. Durable IDs from the
    // local state and trusted origin metadata remain usable in that case.
    const journal = hostState.status === "ready" ? hostState.journal : undefined;
    const hostIds = [...(journal?.knownPrimerThreadIds ?? []), ...(journal?.threadId ? [journal.threadId] : []),
      ...(journal?.pending ? [journal.pending.threadId] : [])];
    const recentMinutes = Math.max(5, vscode.workspace.getConfiguration("codexAutoResume").get<number>("recentThreadMinutes", 480));
    const recentCutoffMs = Date.now() - recentMinutes * 60_000;
    // A thread discovered by cwd alone is NOT evidence that this window owns
    // it. If the window exposes Codex editor tabs, filter DURING pagination,
    // not after selecting the newest workspace thread. Otherwise an unrelated
    // more-recent conversation can indefinitely conceal an interrupted one.
    const visibleIds = this.windowConversationIds();
    const modes = [
      { exact: true, filterSource: true },
      { exact: false, filterSource: true },
      ...(visibleIds.size ? [{ exact: false, filterSource: false }] : []),
    ];
    let staleExact: CodexThread | undefined;
    for (const { exact, filterSource } of modes) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      // Bound work even if an old server returns a nonterminating cursor chain.
      for (let page = 0; page < 20; page += 1) {
        const response: ThreadListResponse = await this.client!.request<ThreadListResponse>("thread/list", {
          limit: exact ? 20 : 100, sortKey: "updated_at", sortDirection: "desc",
          ...(filterSource ? { sourceKinds: ["vscode"] } : {}),
          ...(exact ? { cwd: folders } : {}), archived: false,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(response?.data)) return undefined;
        for (const thread of response.data) {
          if (!thread || typeof thread.id !== "string" || typeof thread.cwd !== "string" ||
              !Number.isFinite(thread.updatedAt) || isPrimerThread(thread, primerState, hostIds) ||
              !isThreadCwdInsideWorkspace(thread.cwd, folders) ||
              (visibleIds.size > 0 && !visibleIds.has(thread.id.toLowerCase()))) continue;
          if (thread.updatedAt * 1000 < recentCutoffMs) {
            if (exact && !staleExact) staleExact = thread;
            continue;
          }
          if (!exact) {
            const key = `workspace-fallback:${thread.id}:${thread.cwd}:${filterSource}`;
            if (key !== this.lastThreadSelectionDiagnostic) {
              this.output.appendLine(`[auto-resume] selected recent ${filterSource ? "workspace-descendant" : "window-visible remote-source"} thread ${thread.id} after scoped lookup`);
              this.lastThreadSelectionDiagnostic = key;
            }
          } else this.lastThreadSelectionDiagnostic = undefined;
          return thread;
        }
        const next = response.nextCursor;
        if (!next || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
    }
    // Preserve the previous stale-thread diagnostic path; it never arms stale work.
    return staleExact;
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
    this.statusBar.command = "codexAutoResume.status";
    if (!this.enabled()) {
      this.statusBar.text = "$(circle-slash) Codex Resume: Off";
      this.statusBar.tooltip = "Codex Auto Resume is disabled";
      return;
    }
    const armed = this.armed();
    let queued: number;
    try {
      queued = this.backlog().length;
    } catch {
      // Damaged state must not crash extension activation or be silently
      // discarded. Show a warning and leave the saved bytes untouched.
      this.statusBar.text = "$(warning) Codex Resume: Queue Invalid";
      this.statusBar.tooltip = "Saved recovery backlog is invalid; no automatic recovery will run. Inspect Output.";
      return;
    }
    if (!armed) {
      const pending = this.pendingQuotaCandidate();
      if (pending) {
        this.statusBar.text = "$(sync) Codex Resume: Quota Check";
        this.statusBar.tooltip = `Interrupted turn ${pending.turnId} is waiting for account quota confirmation`;
        return;
      }
      this.statusBar.text = queued ? `$(list-ordered) Codex Resume: ${queued} queued` : "$(eye) Codex Resume: Monitoring";
      this.statusBar.tooltip = queued ? `${queued} window-visible interrupted conversations saved` : "Watching for a Codex usage-limit interruption";
      return;
    }
    if (armed.resumeTurnId || armed.dispatchPending) {
      this.statusBar.text = queued ? `$(sync) Codex Resume: Verifying (+${queued})` : "$(sync) Codex Resume: Verifying";
      this.statusBar.tooltip = `Continuation ${armed.resumeTurnId ?? "dispatch pending"} is being verified; no duplicate continuation will be sent`;
      return;
    }
    if (this.inputRecoveryEnabled() && !armed.recoveryPlan) {
      this.statusBar.text = "$(sync) Codex Resume: Classifying";
      this.statusBar.tooltip = "Quota-failed turn saved; examining complete input history. No recovery action is confirmed yet.";
      return;
    }
    if (this.inputRecoveryEnabled() && armed.recoveryPlan?.action === "needs_review") {
      const blocked = armed.recoveryPlan.reason.startsWith("attachment_");
      this.statusBar.text = queued ? `$(warning) Codex Resume: Review (+${queued})` : blocked ? "$(warning) Codex Resume: TXT Blocked" : "$(warning) Codex Resume: Review Input";
      this.statusBar.tooltip = blocked
        ? `TXT attachment could not be safely replayed (${armed.recoveryPlan.reason}). Click to inspect; Review cannot bypass integrity checks.`
        : `Recovery is retained, not sent: ${armed.recoveryPlan.reason}. Click to review.`;
      this.statusBar.command = blocked ? "codexAutoResume.inspectRecoveryInput" : "codexAutoResume.reviewRecoveryInput";
      return;
    }
    this.statusBar.text = queued ? `$(clock) Codex Resume: Armed (+${queued})` : this.availabilityCandidate
      ? "$(sync) Codex Resume: Confirming availability"
      : "$(clock) Codex Resume: Armed (awaiting availability)";
    this.statusBar.tooltip = `Thread ${armed.threadId}; backend reset ${armed.resetAtMs > 0 ? new Date(armed.resetAtMs).toLocaleString() : "not supplied"}; sending requires confirmed quota availability`;

  }
}

function isThreadCwdInsideWorkspace(threadCwd: string, workspaceFolders: string[]): boolean {
  if (!threadCwd) return false;
  const windowsPath = (value: string): boolean => /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) || /^\/\/[^/]/.test(value);
  return workspaceFolders.some(folder => {
    const isWindows = windowsPath(folder);
    if (isWindows !== windowsPath(threadCwd)) return false;
    const paths = isWindows ? path.win32 : path.posix;
    if (!paths.isAbsolute(threadCwd) || !paths.isAbsolute(folder)) return false;
    const normalize = (value: string): string => isWindows ? paths.normalize(value).toLowerCase() : paths.normalize(value);
    const root = normalize(folder);
    const candidate = normalize(threadCwd);
    const relative = paths.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
  });
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
