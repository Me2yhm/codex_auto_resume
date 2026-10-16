import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const DISPATCH_DIRECTORY = "work-resume-dispatches";

export interface WorkResumeDispatch {
  threadId: string;
  beforeTurnId: string;
  sentAtMs: number;
  token: string;
}

export type WorkResumeClaim =
  | { status: "claimed"; record: WorkResumeDispatch; releaseUnsent(): Promise<void> }
  | { status: "existing"; record: WorkResumeDispatch };

/**
 * An interrupted work turn has one durable dispatch claim across VS Code
 * windows. Claims never expire: an absent acknowledgement cannot prove that
 * the official owner did not receive a continuation.
 */
export async function claimWorkResume(
  globalStoragePath: string,
  request: { threadId: string; beforeTurnId: string; sentAtMs: number },
): Promise<WorkResumeClaim> {
  if (typeof request.threadId !== "string" || !request.threadId ||
      typeof request.beforeTurnId !== "string" || !request.beforeTurnId ||
      !Number.isFinite(request.sentAtMs)) {
    throw new Error("Invalid work recovery dispatch identity");
  }
  const expected = { threadId: request.threadId, beforeTurnId: request.beforeTurnId };
  const directory = path.join(globalStoragePath, DISPATCH_DIRECTORY);
  const identity = createHash("sha256")
    .update(JSON.stringify([request.threadId, request.beforeTurnId]))
    .digest("hex");
  const filename = path.join(directory, `${identity}.json`);
  await fs.mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await fs.open(filename, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { status: "existing", record: await readDispatch(filename, expected) };
  }

  const token = randomUUID();
  const record: WorkResumeDispatch = { ...expected, sentAtMs: request.sentAtMs, token };
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
  } finally {
    // A failed or partial write remains a fence. A later reader must fail
    // closed rather than silently discard an uncertain dispatch record.
    await handle.close();
  }

  let released = false;
  let releasing: Promise<void> | undefined;
  return {
    status: "claimed",
    record,
    releaseUnsent(): Promise<void> {
      if (released) return Promise.resolve();
      if (releasing) return releasing;
      // Only the creator receives this operation. Coalescing concurrent calls
      // prevents a delayed second release from deleting a successor's claim.
      releasing = (async () => {
        let current: WorkResumeDispatch;
        try {
          current = await readDispatch(filename, expected);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          released = true;
          return;
        }
        if (current.token !== token) {
          released = true;
          return;
        }
        await fs.unlink(filename);
        released = true;
      })().finally(() => { releasing = undefined; });
      return releasing;
    },
  };
}

async function readDispatch(
  filename: string,
  expected: { threadId: string; beforeTurnId: string },
): Promise<WorkResumeDispatch> {
  const value: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted work recovery dispatch");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 ||
      record.threadId !== expected.threadId || record.beforeTurnId !== expected.beforeTurnId ||
      typeof record.sentAtMs !== "number" || !Number.isFinite(record.sentAtMs) ||
      typeof record.token !== "string" ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(record.token)) {
    throw new Error("Invalid persisted work recovery dispatch");
  }
  return record as unknown as WorkResumeDispatch;
}
