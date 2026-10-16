import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
const LOCK_DIR_NAME = "quota-primer-send.lock";
const LOCK_STALE_MS = 5 * 60_000;

export interface QuotaPrimerSendLock {
  release(): Promise<void>;
}

interface LockOwner {
  token?: string;
  pid: number;
  acquiredAtMs: number;
}

interface LockOutput {
  appendLine(message: string): void;
}

export async function tryAcquireQuotaPrimerSendLock(
  globalStoragePath: string,
  output: LockOutput,
): Promise<QuotaPrimerSendLock | undefined> {
  await fs.mkdir(globalStoragePath, { recursive: true });
  const lockPath = path.join(globalStoragePath, LOCK_DIR_NAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && await retireStaleLock(lockPath, output)) continue;
      output.appendLine(
        "[quota-primer] another VS Code extension host on this machine is already handling the primer send; skipping this poll",
      );
      return undefined;
    }

    const token = randomUUID();
    // Exclusive creation also fences a creator paused after mkdir: if the
    // abandoned directory was retired meanwhile it cannot overwrite a successor.
    // On failure leave the unknown lock for stale cleanup instead of risking
    // removing a directory that may already belong to another extension host.
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token, pid: process.pid, acquiredAtMs: Date.now() }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          const owner = await readOwner(lockPath);
          // A stale owner's delayed cleanup must never remove its successor.
          if (owner?.token !== token) return;
          await fs.rm(lockPath, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          output.appendLine("[quota-primer] could not release same-host send lock; it will remain protected until stale cleanup");
        }
      },
    };
  }
  return undefined;
}

async function retireStaleLock(lockPath: string, output: LockOutput): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!stat.isDirectory()) return false;
  const owner = await readOwner(lockPath);
  const lastActivityMs = Math.max(stat.mtimeMs, owner?.acquiredAtMs ?? 0);
  if (Date.now() - lastActivityMs < LOCK_STALE_MS) return false;
  if (owner && processMayBeAlive(owner.pid)) return false;

  // All contenders observing this directory choose the same destination.
  // Keep it nonempty as a fence: a delayed contender cannot rename a newly
  // acquired successor over it. Directly deleting stale directories has that race.
  const identity = createHash("sha256")
    .update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`)
    .digest("hex");
  const retiredPath = `${lockPath}.retired-${identity}`;
  try {
    await fs.writeFile(path.join(lockPath, ".retired-fence"), identity, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code !== "EEXIST") throw error;
  }
  try {
    await fs.rename(lockPath, retiredPath);
    output.appendLine("[quota-primer] retired stale same-host send lock left by an earlier extension host");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return true;
    throw error;
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (
      !value || !Number.isInteger(value.pid) || value.pid <= 0 ||
      !Number.isFinite(value.acquiredAtMs) ||
      (value.token !== undefined && typeof value.token !== "string")
    ) return undefined;
    return value as LockOwner;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
