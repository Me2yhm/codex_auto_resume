import * as fs from "fs/promises";
import * as path from "path";
import type * as vscode from "vscode";

const LOCK_DIR_NAME = "quota-primer-send.lock";
const LOCK_STALE_MS = 5 * 60_000;

export interface QuotaPrimerSendLock {
  release(): Promise<void>;
}

export async function tryAcquireQuotaPrimerSendLock(
  globalStoragePath: string,
  output: vscode.OutputChannel,
): Promise<QuotaPrimerSendLock | undefined> {
  await fs.mkdir(globalStoragePath, { recursive: true });
  const lockPath = path.join(globalStoragePath, LOCK_DIR_NAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          acquiredAtMs: Date.now(),
        }),
        "utf8",
      );

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            await fs.rm(lockPath, { recursive: true, force: true });
          } catch (error) {
            output.appendLine(
              `[quota-primer] could not release same-host send lock: ${(error as Error).message}`,
            );
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      let stale = false;
      try {
        const stat = await fs.stat(lockPath);
        stale = Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode === "ENOENT") continue;
        throw statError;
      }

      if (stale && attempt === 0) {
        output.appendLine(
          "[quota-primer] removing stale same-host send lock left by an earlier extension host",
        );
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }

      output.appendLine(
        "[quota-primer] another VS Code extension host on this machine is already handling the primer send; skipping this poll",
      );
      return undefined;
    }
  }

  return undefined;
}
