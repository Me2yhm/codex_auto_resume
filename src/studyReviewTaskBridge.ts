import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CodexRpcClient } from "./codexRpcClient";
import { resolveCodexExecutable } from "./codexLocator";
import { surfaceOfficialCodexThread } from "./officialCodexUi";
import {
  CodexModelRecord, parseStudyReviewRequest, selectLunaMax,
  buildStudyReviewPrompt, StudyReviewRequest, TASK_ID_PATTERN,
} from "./studyReviewBridgeProtocol";

interface ModelListResponse {
  data: CodexModelRecord[];
  nextCursor: string | null;
}

interface ThreadStartResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string; status?: string };
}

type StatusKind =
  | "dispatch_pending" | "accepted" | "completed"
  | "failed" | "dispatch_unconfirmed";

interface BridgeResult {
  version: 1;
  request_id: string;
  status: StatusKind;
  model_requested: "Luna Max";
  model_selected?: string;
  model_id?: string;
  thread_id?: string;
  turn_id?: string;
  error_code?: string;
  updated_at: string;
}

const POLL_MS = 2_000;
const MAX_CONCURRENT_TURNS = 2;
const MAX_TASK_SIZE = 16_384;
const MAX_TURN_MS = 60 * 60 * 1000;

function writeStatus(file: string, result: Omit<BridgeResult, "updated_at">): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = file + "." + process.pid + ".tmp";
  fs.writeFileSync(target, JSON.stringify({
    ...result, updated_at: new Date().toISOString(),
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(target, file);
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value.includes("model/list")) return "model_discovery_failed";
  if (value.includes("Luna Max")) return "luna_max_unavailable";
  if (value.includes("bundled Codex") || value.includes("Codex executable")
      || value.includes("Codex VS Code extension")) return "codex_executable_unavailable";
  return "codex_dispatch_failed";
}

export class StudyReviewTaskBridge implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private disposed = false;
  private readonly active = new Map<string, CodexRpcClient>();

  constructor(private readonly output: vscode.OutputChannel) {}

  start(): void {
    if (this.disposed) return;
    const enabled = vscode.workspace.getConfiguration("codexAutoResume")
      .get<boolean>("studyReviewBridge.enabled", false);
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.timer) return;
    this.output.appendLine("[study-bridge] enabled; monitoring workspace .tmp/p5 task files");
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async showStatus(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("codexAutoResume")
      .get<boolean>("studyReviewBridge.enabled", false);
    const message = enabled
      ? "Study Review Bridge is enabled; VS Code will automatically dispatch local read-only study review tasks."
      : "Study Review Bridge is disabled. Enable codexAutoResume.studyReviewBridge.enabled in VS Code Settings.";
    void vscode.window.showInformationMessage(message);
  }

  async poll(): Promise<void> {
    if (this.scanning || this.disposed || !this.timer) return;
    this.scanning = true;
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (this.active.size >= MAX_CONCURRENT_TURNS) break;
        const root = folder.uri.fsPath;
        const bridgeRoot = path.join(root, ".tmp", "p5", "codex-bridge");
        const inbox = path.join(bridgeRoot, "requests");
        const processing = path.join(bridgeRoot, "processing");
        const results = path.join(bridgeRoot, "results");
        if (!fs.existsSync(inbox)) continue;
        // Python can distinguish a running VS Code bridge from a queued
        // request without opening any inbound network port.
        fs.writeFileSync(path.join(bridgeRoot, "bridge-ready.json"),
          JSON.stringify({ version: 1, updated_at: new Date().toISOString() }) + "\n",
          { encoding: "utf8", mode: 0o600 });
        fs.mkdirSync(processing, { recursive: true, mode: 0o700 });
        fs.mkdirSync(results, { recursive: true, mode: 0o700 });
        for (const filename of fs.readdirSync(inbox).sort()) {
          if (this.active.size >= MAX_CONCURRENT_TURNS) break;
          if (!/^[a-f0-9]{24}\.json$/.test(filename)) continue;
          const input = path.join(inbox, filename);
          const claimed = path.join(processing, filename);
          const resultFile = path.join(results, filename);
          if (fs.existsSync(resultFile)) {
            // A prior accepted/unknown dispatch must never be resent.
            continue;
          }
          try {
            fs.renameSync(input, claimed);
          } catch {
            continue; // Already claimed by another VS Code instance.
          }
          await this.dispatch(root, claimed, resultFile);
        }
      }
    } catch (error) {
      this.output.appendLine("[study-bridge] queue scan failed: " + errorCode(error));
    } finally {
      this.scanning = false;
    }
  }

  private async dispatch(
    workspaceRoot: string, claimed: string, resultFile: string,
  ): Promise<void> {
    const id = path.basename(claimed, ".json");
    if (!TASK_ID_PATTERN.test(id)) return;
    let request: StudyReviewRequest;
    try {
      const stat = fs.statSync(claimed);
      if (!stat.isFile() || stat.size > MAX_TASK_SIZE) {
        throw new Error("Oversized or non-file study-review task");
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(claimed, "utf8"));
      request = parseStudyReviewRequest(parsed, workspaceRoot);
      if (request.request_id !== id) throw new Error("Task name and request ID disagree");
      if (!fs.statSync(request.task_file).isFile()) {
        throw new Error("The locally recorded review task is missing");
      }
    } catch {
      writeStatus(resultFile, {
        version: 1, request_id: id, status: "failed",
        model_requested: "Luna Max", error_code: "invalid_study_task",
      });
      return;
    }

    const base: Omit<BridgeResult, "updated_at"> = {
      version: 1, request_id: id, status: "dispatch_pending",
      model_requested: "Luna Max",
    };
    writeStatus(resultFile, base);
    let client: CodexRpcClient | undefined;
    let turnAttempted = false;
    let handedOff = false;
    try {
      client = new CodexRpcClient(resolveCodexExecutable(this.output), this.output, {
        name: "codex-auto-resume-study-bridge",
        title: "Codex Auto Resume Study Review Bridge",
        version: "0.3.11",
      });
      client.on("error", () => {
        // CodexRpcClient rejects pending requests itself; avoid an
        // unhandled EventEmitter error crashing the extension host.
      });
      await client.start();

      const models: CodexModelRecord[] = [];
      let cursor: string | null = null;
      do {
        const response: ModelListResponse = await client.request(
          "model/list", { limit: 100, includeHidden: true, cursor }, 20_000,
        );
        models.push(...response.data);
        cursor = response.nextCursor;
        if (models.length > 2_000) throw new Error("Unexpected Codex model list size");
      } while (cursor);
      const selected = selectLunaMax(models);
      const started = await client.request<ThreadStartResponse>("thread/start", {
        cwd: workspaceRoot,
        model: selected.model,
        serviceName: "auto-lessons-study-review",
        threadSource: "auto_lessons_study_review",
        ephemeral: false,
      }, 30_000);
      const threadId = started.thread.id;
      if (!threadId) throw new Error("Missing Codex thread identity");
      const selectedResult: Omit<BridgeResult, "updated_at"> = {
        ...base, model_selected: selected.displayName, model_id: selected.model,
        thread_id: threadId,
      };
      writeStatus(resultFile, selectedResult);

      const prompt = buildStudyReviewPrompt(request);
      turnAttempted = true;
      const turn = await client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: selected.model,
      }, 30_000);
      const turnId = turn.turn?.id;
      if (!turnId) throw new Error("Codex turn/start returned no turn ID");
      const accepted: Omit<BridgeResult, "updated_at"> = {
        ...selectedResult, turn_id: turnId, status: "accepted",
      };
      writeStatus(resultFile, accepted);
      this.active.set(id, client);
      handedOff = true;
      this.output.appendLine("[study-bridge] accepted task " + id + " with verified Luna Max");
      // The official UI is best-effort; the prompt has already been sent
      // by App Server RPC. The recorded model and turn identity are real.
      void surfaceOfficialCodexThread(threadId, this.output, "study-bridge")
        .catch(() => this.output.appendLine("[study-bridge] thread UI surfacing unavailable"));
      let settled = false;
      const settle = (status: "completed" | "failed"): void => {
        if (settled) return;
        settled = true;
        writeStatus(resultFile, { ...accepted, status });
        this.active.delete(id);
        client?.dispose();
      };
      const timeout = setTimeout(() => settle("failed"), MAX_TURN_MS);
      client.on("notification", (method: string, params: unknown) => {
        if (method !== "turn/completed") return;
        const event = params as { threadId?: string; turn?: { id?: string; status?: string } };
        if (event?.threadId !== threadId || event.turn?.id !== turnId) return;
        clearTimeout(timeout);
        settle(event.turn?.status === "completed" ? "completed" : "failed");
      });
      if (turn.turn.status === "completed" || turn.turn.status === "failed") {
        clearTimeout(timeout);
        settle(turn.turn.status);
      }
    } catch (error) {
      writeStatus(resultFile, {
        ...base,
        status: turnAttempted ? "dispatch_unconfirmed" : "failed",
        error_code: errorCode(error),
      });
      this.output.appendLine("[study-bridge] task " + id + " failed: " + errorCode(error));
    } finally {
      if (!handedOff) client?.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const client of this.active.values()) client.dispose();
    this.active.clear();
  }
}
