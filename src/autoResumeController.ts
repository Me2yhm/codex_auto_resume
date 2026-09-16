import * as vscode from "vscode";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import { CodexUiIpcClient, readCodexUiIpcVersions } from "./codexUiIpc";
import { addTextToOfficialCodexThread, tryNativeChatSubmit } from "./officialCodexBridge";
import {
  ArmedResume,
  CodexThread,
  CodexTurn,
  RateLimitSnapshot,
  RateLimitsReadResponse,
  ThreadListResponse,
  ThreadTurnsListResponse,
} from "./types";

const STATE_KEY = "codexAutoResume.armed";

export class AutoResumeController implements vscode.Disposable {
  private client?: CodexRpcClient;
  private timer?: NodeJS.Timeout;
  private running = false;
  private statusBar: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = "codexAutoResume.status";
    this.statusBar.show();
    this.renderStatus();
  }

  async start(): Promise<void> {
    if (!this.enabled()) {
      this.renderStatus();
      return;
    }
    await this.ensureClient();
    await this.tick();
  }

  async enable(): Promise<void> {
    await vscode.workspace.getConfiguration("codexAutoResume").update("enabled", true, vscode.ConfigurationTarget.Global);
    await this.start();
    void vscode.window.showInformationMessage("Codex Auto Resume enabled.");
  }

  async disable(): Promise<void> {
    await vscode.workspace.getConfiguration("codexAutoResume").update("enabled", false, vscode.ConfigurationTarget.Global);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.context.workspaceState.update(STATE_KEY, undefined);
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
      void vscode.window.showInformationMessage("Codex Auto Resume is enabled and monitoring; no interrupted thread is armed.");
      return;
    }
    const reset = new Date(armed.resetAtMs).toLocaleString();
    void vscode.window.showInformationMessage(`Codex Auto Resume is armed for thread ${armed.threadId}. Resume after ${reset}.`);
  }

  async resumeNow(): Promise<void> {
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
    if (this.timer) clearTimeout(this.timer);
    this.client?.dispose();
    this.statusBar.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("codexAutoResume").get<boolean>("enabled", false);
  }

  private armed(): ArmedResume | undefined {
    return this.context.workspaceState.get<ArmedResume>(STATE_KEY);
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
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      await this.ensureClient();
      const limits = await this.readRateLimits();
      const armed = this.armed();

      if (armed) {
        if (Date.now() >= armed.resetAtMs + this.resetGraceMs()) {
          if (this.quotaLooksAvailable(limits)) {
            await this.tryAutomaticResume(armed);
          } else {
            const nextReset = this.computeResetAt(limits);
            if (nextReset) {
              await this.context.workspaceState.update(STATE_KEY, { ...armed, resetAtMs: nextReset });
              this.output.appendLine(
                `[auto-resume] quota still unavailable for ${armed.threadId}; next reset ${new Date(nextReset).toISOString()}`,
              );
            }
          }
        }
      } else {
        const interrupted = await this.findInterruptedThread();
        if (interrupted) {
          const resetAtMs = this.computeResetAt(limits);
          if (resetAtMs) {
            const record: ArmedResume = {
              threadId: interrupted.thread.id,
              cwd: interrupted.thread.cwd,
              armedAtMs: Date.now(),
              resetAtMs,
              reason: interrupted.reason,
            };
            await this.context.workspaceState.update(STATE_KEY, record);
            this.output.appendLine(`[auto-resume] armed thread ${record.threadId} until ${new Date(resetAtMs).toISOString()}`);
          }
        }
      }
    } catch (error) {
      this.output.appendLine(`[auto-resume] tick failed: ${(error as Error).message}`);
      this.client?.dispose();
      this.client = undefined;
    } finally {
      this.running = false;
      this.renderStatus();
      this.scheduleNextTick();
    }
  }

  private async tryAutomaticResume(armed: ArmedResume): Promise<void> {
    const before = await this.latestTurn(armed.threadId);
    this.output.appendLine(`[auto-resume] quota available; attempting UI IPC resume for ${armed.threadId}`);

    const sent = await this.sendThroughOfficialUi(armed.threadId, this.resumePrompt(), "auto-resume");
    if (!sent) {
      this.output.appendLine(
        `[auto-resume] no active UI owner for ${armed.threadId}; keeping thread armed and retrying on the next poll`,
      );
      return;
    }

    const verified = await this.verifyNewTurn(armed.threadId, before?.id, "auto-resume");
    if (!verified) {
      this.output.appendLine(
        `[auto-resume] start-turn was accepted but no new turn was observed for ${armed.threadId}; keeping thread armed`,
      );
      return;
    }

    await this.context.workspaceState.update(STATE_KEY, undefined);
    this.output.appendLine(`[auto-resume] resumed and disarmed thread ${armed.threadId}`);
  }

  private async sendThroughOfficialUi(threadId: string, prompt: string, logPrefix: string): Promise<boolean> {
    this.output.appendLine(`[${logPrefix}] opening official Codex sidebar before owner discovery`);
    await vscode.commands.executeCommand("chatgpt.openSidebar");
    await delay(1500);

    const versions = readCodexUiIpcVersions(this.output);
    const ipc = new CodexUiIpcClient(this.output);
    try {
      await ipc.connect();
      let ownerClientId: string | undefined;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        ownerClientId = await ipc.discoverOwner(threadId, versions.ownerDiscovery);
        this.output.appendLine(`[${logPrefix}] owner discovery ${attempt}/5: ${ownerClientId ?? "<none>"}`);
        if (ownerClientId) break;
        await delay(1000);
      }
      if (!ownerClientId) return false;
      await ipc.startTurn(threadId, prompt, versions, ownerClientId);
      return true;
    } finally {
      ipc.dispose();
    }
  }

  private scheduleNextTick(): void {
    if (!this.enabled()) return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = Math.max(15, vscode.workspace.getConfiguration("codexAutoResume").get<number>("pollIntervalSeconds", 60));
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
  }

  private async readRateLimits(): Promise<RateLimitSnapshot | null> {
    const response = await this.client!.request<RateLimitsReadResponse>("account/rateLimits/read", {});
    return response.rateLimits ?? null;
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

  private async verifyNewTurn(threadId: string, beforeTurnId: string | undefined, logPrefix: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await delay(1000);
      const after = await this.latestTurn(threadId);
      this.output.appendLine(`[${logPrefix}] verification ${attempt}/12 latest turn: ${after?.id ?? "<none>"}`);
      if (after?.id && after.id !== beforeTurnId) {
        this.output.appendLine(
          `[${logPrefix}] SUCCESS: a new turn appeared on the same thread (${after.id}); status=${after.status}; error=${formatTurnError(after)}.`,
        );
        return true;
      }
    }
    this.output.appendLine(`[${logPrefix}] FAILED: no new turn appeared on the target thread.`);
    return false;
  }

  private async findInterruptedThread(): Promise<{ thread: CodexThread; reason: ArmedResume["reason"] } | undefined> {
    const thread = await this.findMostRecentThread();
    if (!thread) return undefined;

    const ageMinutes = (Date.now() - thread.updatedAt * 1000) / 60_000;
    const recentMinutes = Math.max(5, vscode.workspace.getConfiguration("codexAutoResume").get<number>("recentThreadMinutes", 180));
    if (ageMinutes > recentMinutes) return undefined;

    const latest = await this.latestTurn(thread.id);
    const reason = classifyLimitError(latest);
    return reason ? { thread, reason } : undefined;
  }

  private async findMostRecentThread(): Promise<CodexThread | undefined> {
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (folders.length === 0) return undefined;

    const response = await this.client!.request<ThreadListResponse>("thread/list", {
      limit: 20,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["vscode"],
      cwd: folders,
      archived: false,
    });
    return response.data[0];
  }

  private computeResetAt(limits: RateLimitSnapshot | null): number | undefined {
    if (!limits) return undefined;
    const exhausted = [limits.primary, limits.secondary]
      .filter((window): window is NonNullable<typeof window> => Boolean(window))
      .filter((window) => window.usedPercent >= 99)
      .map((window) => window.resetsAt)
      .filter((value): value is number => typeof value === "number" && value * 1000 > Date.now());

    if (exhausted.length > 0) return Math.max(...exhausted) * 1000;

    const future = [limits.primary?.resetsAt, limits.secondary?.resetsAt]
      .filter((value): value is number => typeof value === "number" && value * 1000 > Date.now());
    return future.length > 0 ? Math.min(...future) * 1000 : undefined;
  }

  private quotaLooksAvailable(limits: RateLimitSnapshot | null): boolean {
    if (!limits) return true;
    if (limits.rateLimitReachedType) return false;
    const windows = [limits.primary, limits.secondary].filter((window): window is NonNullable<typeof window> => Boolean(window));
    return windows.every((window) => window.usedPercent < 99);
  }

  private resetGraceMs(): number {
    const seconds = Math.max(0, vscode.workspace.getConfiguration("codexAutoResume").get<number>("resetGraceSeconds", 90));
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
      this.statusBar.text = "$(eye) Codex Resume: Monitoring";
      this.statusBar.tooltip = "Watching for a Codex usage-limit interruption";
      return;
    }
    const reset = new Date(armed.resetAtMs).toLocaleTimeString();
    this.statusBar.text = `$(clock) Codex Resume: ${reset}`;
    this.statusBar.tooltip = `Thread ${armed.threadId} is armed for automatic UI IPC resume`;
  }
}

function classifyLimitError(turn: CodexTurn | undefined): ArmedResume["reason"] | undefined {
  const info = turn?.error?.codexErrorInfo;
  if (info === "usageLimitExceeded") return "usageLimitExceeded";
  if (info === "rateLimitExceeded") return "rateLimitExceeded";
  return undefined;
}

function formatTurnError(turn: CodexTurn): string {
  const info = turn.error?.codexErrorInfo;
  if (typeof info === "string") return info;
  if (info) return JSON.stringify(info);
  return turn.error?.message ?? "none";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
