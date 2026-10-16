import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const REGISTRY_DIRECTORY = "recovery-coordination";
const HEARTBEAT_MS = 15_000;
const LEASE_MS = 120_000;
const STALE_GRACE_MS = 30_000;

export type RecoveryPhase = "pending" | "armed" | "verifying";

export interface RecoveryRegistration {
  phase: RecoveryPhase;
  threadId: string;
}

export interface RecoveryLease extends RecoveryRegistration {
  schemaVersion: 1;
  instanceId: string;
  workspaceId: string;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface RecoveryPriority {
  status: "clear" | "active" | "unknown";
  records: RecoveryLease[];
  reason?: string;
}

interface CoordinationOutput {
  appendLine(message: string): void;
}

interface RecoveryCoordinatorOptions {
  heartbeatMs?: number;
  leaseMs?: number;
}

/** Separate host leases keep workspace Memento caches out of coordination. */
export class RecoveryCoordinator {
  private readonly instanceId = randomUUID();
  private readonly directory: string;
  private readonly leasePath: string;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private state?: RecoveryRegistration;
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private heartbeatFailureLogged = false;

  constructor(
    globalStoragePath: string,
    private readonly workspaceId: string,
    private readonly output: CoordinationOutput,
    options: RecoveryCoordinatorOptions = {},
  ) {
    this.directory = path.join(globalStoragePath, REGISTRY_DIRECTORY);
    this.leasePath = path.join(this.directory, `${this.instanceId}.json`);
    this.heartbeatMs = positiveDuration(options.heartbeatMs, HEARTBEAT_MS);
    this.leaseMs = Math.max(this.heartbeatMs * 2, positiveDuration(options.leaseMs, LEASE_MS));
  }

  /** Publish before Primer's final preflight; callers must not let failures stop recovery. */
  set(state: RecoveryRegistration | undefined): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.state = state ? { ...state } : undefined;
    this.stopHeartbeat();
    if (this.state) this.scheduleHeartbeat();
    const snapshot = this.state;
    return this.enqueue(() => this.publish(snapshot));
  }

  clear(): Promise<void> {
    return this.set(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = undefined;
    this.stopHeartbeat();
    void this.enqueue(() => this.publish(undefined)).catch(() => {
      this.output.appendLine("[recovery-coordination] could not remove the closing host's lease; it will expire");
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    // A failed write must not poison later heartbeat, clear, or disposal operations.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async publish(state: RecoveryRegistration | undefined): Promise<void> {
    if (!state) {
      await fs.rm(this.leasePath, { force: true });
      return;
    }
    await fs.mkdir(this.directory, { recursive: true });
    const updatedAtMs = Date.now();
    const lease: RecoveryLease = {
      schemaVersion: 1,
      instanceId: this.instanceId,
      workspaceId: this.workspaceId,
      ...state,
      updatedAtMs,
      expiresAtMs: updatedAtMs + this.leaseMs,
    };
    const temporaryPath = `${this.leasePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.leasePath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private scheduleHeartbeat(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || !this.state) return;
      const snapshot = this.state;
      void this.enqueue(() => this.publish(snapshot))
        .then(() => { this.heartbeatFailureLogged = false; })
        .catch(() => {
          if (this.heartbeatFailureLogged) return;
          this.heartbeatFailureLogged = true;
          this.output.appendLine("[recovery-coordination] recovery lease heartbeat failed; automatic recovery remains enabled");
        });
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
    this.timer.unref();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Failure is unknown so Primer skips, without affecting Auto Resume. */
export async function readRecoveryPriority(
  globalStoragePath: string,
  options: { nowMs?: number; staleGraceMs?: number } = {},
): Promise<RecoveryPriority> {
  const directory = path.join(globalStoragePath, REGISTRY_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "clear", records: [] };
    return { status: "unknown", records: [], reason: "registry-unreadable" };
  }
  const records: RecoveryLease[] = [];
  const nowMs = options.nowMs ?? Date.now();
  const staleGraceMs = Math.max(0, options.staleGraceMs ?? STALE_GRACE_MS);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return { status: "unknown", records, reason: "registry-entry-invalid" };
    }
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { status: "unknown", records, reason: "registry-entry-unreadable" };
    }
    if (!isRecoveryLease(value) || entry.name !== `${value.instanceId}.json`) {
      return { status: "unknown", records, reason: "registry-entry-invalid" };
    }
    if (nowMs > value.expiresAtMs + staleGraceMs) {
      // Never unlink another host's lease: a heartbeat may have replaced this
      // path since our read. Ignoring expired leases safely handles host crashes.
      continue;
    }
    records.push(value);
  }
  return { status: records.length ? "active" : "clear", records };
}

function isRecoveryLease(value: unknown): value is RecoveryLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    typeof record.instanceId === "string" && /^[\w-]+$/.test(record.instanceId) &&
    typeof record.workspaceId === "string" &&
    typeof record.threadId === "string" && record.threadId.length > 0 &&
    (record.phase === "pending" || record.phase === "armed" || record.phase === "verifying") &&
    typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs) &&
    typeof record.expiresAtMs === "number" && Number.isFinite(record.expiresAtMs) &&
    record.expiresAtMs > record.updatedAtMs;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
