import { createHash } from "crypto";
import { constants as fileConstants, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { TextDecoder } from "util";
import {
  MAX_INPUT_BYTES, originalReplayText, pastedTxtReferences, replayText,
  type AttachmentIntegrity, type PastedTxtSnapshot, type RecoveryPlan,
} from "./inputRecovery";

// Constrain snapshots to the official Codex pasted-attachment directory.
// Arbitrary paths supplied by user/agent text must never be opened.
export const MAX_PASTED_TXT_BYTES = 192 * 1024;
export const MAX_PASTED_TXT_COUNT = 4;
type BlockedReason = Exclude<AttachmentIntegrity["status"], "verified" | "unverified">;

class AttachmentReadError extends Error {
  constructor(readonly code: BlockedReason) { super(code); }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function codexAttachmentRoot(override?: string): string {
  const home = override ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.resolve(home, "attachments");
}

/** Prevent absolute-file and symlink escapes even if the input is malicious. */
async function readOfficialPastedTxt(sourcePath: string, root: string): Promise<PastedTxtSnapshot> {
  if (!path.isAbsolute(sourcePath) || path.resolve(sourcePath) !== sourcePath) {
    throw new AttachmentReadError("unsafe_reference");
  }
  const relative = path.relative(root, sourcePath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !/^[a-f0-9-]{32,36}$/i.test(parts[0]) ||
      !/\.txt$/i.test(parts[1]) || !parts[1].trim()) {
    throw new AttachmentReadError("unsafe_reference");
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const actualRoot = await fs.realpath(root);
    const actualPath = await fs.realpath(sourcePath);
    if (!actualPath.startsWith(actualRoot + path.sep)) throw new AttachmentReadError("unsafe_reference");
    const file = await fs.lstat(sourcePath);
    if (!file.isFile() || file.isSymbolicLink()) throw new AttachmentReadError("unsafe_reference");
    if (file.size > MAX_PASTED_TXT_BYTES) throw new AttachmentReadError("too_large");
    if (file.size === 0) throw new AttachmentReadError("missing");
    const openFlags = fileConstants.O_RDONLY |
      (process.platform === "win32" ? 0 : (fileConstants.O_NOFOLLOW ?? 0));
    handle = await fs.open(sourcePath, openFlags);
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PASTED_TXT_BYTES) throw new AttachmentReadError("too_large");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new AttachmentReadError("modified");
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text || text.includes("\u0000")) throw new AttachmentReadError("unsupported_encoding");
    return { sourcePath, sha256: sha256(bytes), byteLength: bytes.length, text };
  } catch (error) {
    if (error instanceof AttachmentReadError) throw error;
    if (error instanceof TypeError) throw new AttachmentReadError("unsupported_encoding");
    throw new AttachmentReadError("missing");
  } finally {
    await handle?.close();
  }
}

/** Read and pin original UTF-8 bytes on the extension host, before any quota
 * dispatch. Subsequent observations must match the pinned digest and bytes.
 * Source changes never silently replace an approved original attachment. */
export async function materializePastedTxt(
  plan: RecoveryPlan,
  previous?: RecoveryPlan,
  codexHomeOverride?: string,
): Promise<RecoveryPlan> {
  if (plan.candidate !== "replay_input") return plan;
  const original = originalReplayText(plan);
  if (original === undefined) return plan;
  const refs = pastedTxtReferences(original);
  if (!refs.present) return plan;
  const prior = previous?.fingerprint === plan.fingerprint ? previous.pastedTxtSnapshots : undefined;
  const status = (code: BlockedReason, saved?: PastedTxtSnapshot[]): RecoveryPlan => ({
    ...plan, action: "needs_review", reason: "attachment_" + code,
    approval: undefined, stale: true, pastedTxtSnapshots: saved,
    attachmentIntegrity: { status: code, count: refs.references.length,
      bytes: saved?.reduce((sum, item) => sum + item.byteLength, 0) ?? 0 },
  });
  if (refs.error || refs.references.length > MAX_PASTED_TXT_COUNT) {
    return status("invalid_reference", prior);
  }
  const root = codexAttachmentRoot(codexHomeOverride);
  const snapshots: PastedTxtSnapshot[] = [];
  try {
    for (const ref of refs.references) {
      const fresh = await readOfficialPastedTxt(ref, root);
      const previousSnapshot = prior?.find(snapshot => snapshot.sourcePath === ref);
      if (prior && (!previousSnapshot || previousSnapshot.sha256 !== fresh.sha256 ||
          previousSnapshot.byteLength !== fresh.byteLength ||
          sha256(Buffer.from(previousSnapshot.text, "utf8")) !== previousSnapshot.sha256)) {
        throw new AttachmentReadError("modified");
      }
      snapshots.push(previousSnapshot ?? fresh);
    }
  } catch (error) {
    return status(error instanceof AttachmentReadError ? error.code : "missing", prior);
  }
  const attached: RecoveryPlan = {
    ...plan, pastedTxtSnapshots: snapshots,
    attachmentIntegrity: { status: "verified", count: snapshots.length,
      bytes: snapshots.reduce((sum, item) => sum + item.byteLength, 0) },
  };
  // Maximum payload includes the original message, delimiters and attachment
  // bodies; never send or claim that an oversized message was fully replayed.
  if (replayText(attached) === undefined) {
    const marker = "[Codex Auto Resume: verified contents of pasted TXT attachment ";
    return status(original.includes(marker) ? "invalid_reference" : "too_large", snapshots);
  }
  return attached;
}

/** Use at the FINAL official-owner pre-startTurn guard, not only when Armed.
 * This is read-only. A replaced, deleted, or unreadable original blocks send. */
export async function verifyPastedTxtBeforeSend(plan: RecoveryPlan, codexHomeOverride?: string): Promise<boolean> {
  if (plan.action !== "replay_input") return true;
  const validated = await materializePastedTxt(plan, plan, codexHomeOverride);
  return validated.attachmentIntegrity?.status !== "verified"
    ? !pastedTxtReferences(originalReplayText(plan) ?? "").present
    : replayText(validated) === replayText(plan);
}
