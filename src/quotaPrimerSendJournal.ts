import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { QuotaPrimerPendingConfirmation } from "./quotaPrimerState";

export const QUOTA_PRIMER_SEND_JOURNAL_FILE = "quota-primer-send.json";

export interface QuotaPrimerJournalPending extends QuotaPrimerPendingConfirmation {
  threadId: string;
  beforeTurnId?: string;
  manual?: boolean;
}

/** Authoritative same-host send intent, independent of cached VS Code Mementos. */
export interface QuotaPrimerSendJournal {
  version: 1;
  updatedAtMs: number;
  threadId?: string;
  pending?: QuotaPrimerJournalPending;
  handledPrimaryResetAtMs?: number;
  handledSecondaryResetAtMs?: number;
  nextPrimaryResetAtMs?: number;
  nextSecondaryResetAtMs?: number;
}

export type QuotaPrimerSendJournalRead =
  | { status: "ready"; journal: QuotaPrimerSendJournal }
  | { status: "unknown"; reason: string };

export async function readQuotaPrimerSendJournal(storagePath: string): Promise<QuotaPrimerSendJournalRead> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(storagePath, QUOTA_PRIMER_SEND_JOURNAL_FILE), "utf8"));
    if (!validJournal(value)) return { status: "unknown", reason: "malformed primer send journal" };
    return { status: "ready", journal: value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ready", journal: { version: 1, updatedAtMs: 0 } };
    }
    return { status: "unknown", reason: "unreadable primer send journal" };
  }
}

/** Caller holds the same-host send lock; atomic rename protects concurrent readers. */
export async function writeQuotaPrimerSendJournal(storagePath: string, journal: QuotaPrimerSendJournal): Promise<void> {
  const current = { ...journal, version: 1 as const, updatedAtMs: Date.now() };
  if (!validJournal(current)) throw new Error("Invalid primer send journal update");
  await fs.mkdir(storagePath, { recursive: true });
  const target = path.join(storagePath, QUOTA_PRIMER_SEND_JOURNAL_FILE);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(current), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function validJournal(value: unknown): value is QuotaPrimerSendJournal {
  if (!record(value) || value.version !== 1 || !number(value.updatedAtMs) || !optionalString(value.threadId)) return false;
  for (const key of ["handledPrimaryResetAtMs", "handledSecondaryResetAtMs", "nextPrimaryResetAtMs", "nextSecondaryResetAtMs"]) {
    if (!optionalNumber(value[key])) return false;
  }
  if (value.pending === undefined) return true;
  const pending = value.pending;
  if (!record(pending) || !optionalString(pending.threadId) || !pending.threadId ||
      !number(pending.sentAtMs) || !optionalString(pending.beforeTurnId) || !optionalString(pending.turnId) ||
      !(pending.manual === undefined || typeof pending.manual === "boolean") ||
      !(pending.stalledWarningLogged === undefined || typeof pending.stalledWarningLogged === "boolean")) return false;
  return ["primaryResetAtMs", "secondaryResetAtMs", "primaryProbeObservedAtMs", "primaryProbeResetAtMs",
    "secondaryProbeObservedAtMs", "secondaryProbeResetAtMs"].every((key) => optionalNumber(pending[key]));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function optionalNumber(value: unknown): boolean { return value === undefined || number(value); }
function optionalString(value: unknown): boolean { return value === undefined || (typeof value === "string" && value.length > 0); }
