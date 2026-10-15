import { migrateQuotaPrimerState, QuotaPrimerState } from "./quotaPrimerState";
import { CodexThread } from "./types";

export const PRIMER_THREAD_SOURCE = "codex-auto-resume-primer";

/** Only persisted IDs and origin metadata identify a Primer; user text never does. */
export function isPrimerThread(
  thread: CodexThread,
  state?: QuotaPrimerState,
  hostKnownIds: readonly string[] = [],
): boolean {
  const known = migrateQuotaPrimerState(state).knownPrimerThreadIds!;
  if (known.includes(thread.id) || hostKnownIds.includes(thread.id)) return true;
  if (thread.threadSource === PRIMER_THREAD_SOURCE || thread.originator === PRIMER_THREAD_SOURCE ||
      thread.source === PRIMER_THREAD_SOURCE) return true;
  if (thread.source && typeof thread.source === "object" && !Array.isArray(thread.source)) {
    const source = thread.source as Record<string, unknown>;
    return [source.custom, source.threadSource, source.originator, source.serviceName].some(value => value === PRIMER_THREAD_SOURCE);
  }
  return false;
}
