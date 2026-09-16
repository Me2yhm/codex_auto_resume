import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

interface IpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  handledByClientId?: string;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexUiIpcVersions {
  ownerDiscovery: number;
  startTurn: number;
}

const INITIALIZING_CLIENT_ID = "initializing-client";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export function readCodexUiIpcVersions(output: vscode.OutputChannel): CodexUiIpcVersions {
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (!extension) throw new Error("Official openai.chatgpt extension is not installed.");

  const packageJson = extension.packageJSON as { main?: string; version?: string };
  if (!packageJson.main) throw new Error("Official openai.chatgpt extension has no main bundle entry.");

  const mainPath = path.resolve(extension.extensionPath, packageJson.main);
  const source = fs.readFileSync(mainPath, "utf8");

  const ownerDiscovery = extractMethodVersion(source, "thread-owner-discovery");
  const startTurn = extractMethodVersion(source, "thread-follower-start-turn");

  output.appendLine(
    `[ui-ipc] openai.chatgpt ${packageJson.version ?? "unknown"}; thread-owner-discovery=v${ownerDiscovery}; thread-follower-start-turn=v${startTurn}`,
  );
  return { ownerDiscovery, startTurn };
}

function extractMethodVersion(source: string, method: string): number {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`["']${escaped}["']\\s*:\\s*(\\d+)`, "g");
  const versions = new Set<number>();
  for (const match of source.matchAll(expression)) {
    versions.add(Number(match[1]));
  }
  if (versions.size === 0) {
    throw new Error(`Could not discover Codex UI IPC version for ${method} from the installed extension bundle.`);
  }
  if (versions.size > 1) {
    throw new Error(`Ambiguous Codex UI IPC versions for ${method}: ${[...versions].join(", ")}`);
  }
  return [...versions][0];
}

export function resolveCodexUiIpcSocketPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "ipc", "ipc.sock");
}

export class CodexUiIpcClient implements vscode.Disposable {
  private socket?: net.Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private clientId = INITIALIZING_CLIENT_ID;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly socketPath = resolveCodexUiIpcSocketPath(),
  ) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    this.output.appendLine(`[ui-ipc] connecting to ${this.socketPath}`);
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.onSocketError(error));
    socket.on("close", () => this.onSocketClose());

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    const initialized = await this.request(
      "initialize",
      0,
      { clientType: "codex-auto-resume" },
      undefined,
      DEFAULT_TIMEOUT_MS,
    );
    const result = asRecord(initialized.result);
    const assigned = typeof result?.clientId === "string" ? result.clientId : undefined;
    if (!assigned) throw new Error("Codex UI IPC initialize response did not include clientId.");
    this.clientId = assigned;
    this.output.appendLine(`[ui-ipc] initialized as ${assigned}`);
  }

  async startTurn(
    threadId: string,
    prompt: string,
    versions: CodexUiIpcVersions,
  ): Promise<void> {
    await this.connect();

    const ownerResponse = await this.request(
      "thread-owner-discovery",
      versions.ownerDiscovery,
      { hostId: "local", conversationId: threadId },
    );
    const ownerClientId = ownerResponse.handledByClientId;
    if (!ownerClientId) {
      throw new Error("Codex UI IPC could not discover an active owner for the target thread.");
    }
    this.output.appendLine(`[ui-ipc] owner for ${threadId}: ${ownerClientId}`);

    await this.request(
      "thread-follower-start-turn",
      versions.startTurn,
      {
        conversationId: threadId,
        turnStart: {
          request: {
            threadId,
            clientUserMessageId: crypto.randomUUID(),
            input: [{ type: "text", text: prompt, text_elements: [] }],
          },
          context: { inheritThreadSettings: true },
        },
      },
      ownerClientId,
      10_000,
    );
    this.output.appendLine(`[ui-ipc] thread-follower-start-turn accepted for ${threadId}`);
  }

  dispose(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectAll(new Error("Codex UI IPC client disposed."));
  }

  private request(
    method: string,
    version: number,
    params: unknown,
    targetClientId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<IpcResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex UI IPC socket is not connected.");

    const requestId = crypto.randomUUID();
    const frame: Record<string, unknown> = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      timeoutMs,
    };
    if (targetClientId) frame.targetClientId = targetClientId;

    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex UI IPC request timed out: ${method}`));
      }, timeoutMs + 250);
      this.pending.set(requestId, { resolve, reject, timer });

      try {
        socket.write(encodeFrame(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error as Error);
      }
    });
  }

  private onData(chunk: Buffer<ArrayBufferLike>): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.onSocketError(new Error(`Invalid Codex UI IPC frame length: ${length}`));
        return;
      }
      if (this.buffer.length < 4 + length) return;

      const payload = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);

      let message: unknown;
      try {
        message = JSON.parse(payload);
      } catch (error) {
        this.onSocketError(new Error(`Invalid Codex UI IPC JSON: ${(error as Error).message}`));
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: unknown): void {
    const record = asRecord(message);
    if (!record) return;

    if (record.type === "client-discovery-request" && typeof record.requestId === "string") {
      this.socket?.write(
        encodeFrame({
          type: "client-discovery-response",
          requestId: record.requestId,
          response: { canHandle: false },
        }),
      );
      return;
    }

    if (record.type !== "response" || typeof record.requestId !== "string") return;
    const pending = this.pending.get(record.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(record.requestId);
    const response = record as unknown as IpcResponse;
    if (response.resultType === "error") {
      pending.reject(new Error(`Codex UI IPC ${response.method ?? "request"} failed: ${response.error ?? "unknown error"}`));
      return;
    }
    pending.resolve(response);
  }

  private onSocketError(error: Error): void {
    this.output.appendLine(`[ui-ipc] socket error: ${error.message}`);
    this.rejectAll(error);
  }

  private onSocketClose(): void {
    this.output.appendLine("[ui-ipc] socket closed");
    this.rejectAll(new Error("Codex UI IPC socket closed."));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length <= 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error(`Codex UI IPC payload is invalid (${payload.length} bytes).`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
