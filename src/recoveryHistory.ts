import type { CodexTurn, ThreadTurnsListResponse } from "./types";
import { hasRecordedProgress, isQuotaFailure, record, RecoveryHistory } from "./inputRecovery";

export interface HistoryReader {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/** Read only; never resume a thread, acquire its writer, or invoke a tool. */
export async function readRecoveryHistory(client: HistoryReader, threadId: string): Promise<RecoveryHistory> {
  const turns: CodexTurn[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let bytes = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response: ThreadTurnsListResponse = await client.request("thread/turns/list", {
        threadId, limit: PAGE_SIZE, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}),
      }, 15_000);
      if (!record(response) || !Array.isArray(response.data) ||
          !(response.nextCursor === null || typeof response.nextCursor === "string")) {
        return { turns, complete: false, reason: "malformed_history_page" };
      }
      bytes += Buffer.byteLength(JSON.stringify(response), "utf8");
      if (bytes > MAX_HISTORY_BYTES) return { turns, complete: false, reason: "history_too_large" };
      for (const turn of response.data) {
        if (!record(turn) || typeof turn.id !== "string" || !turn.id || ids.has(turn.id) ||
            !["failed", "interrupted", "completed", "inProgress"].includes(turn.status) ||
            turn.itemsView !== "full" || !Array.isArray(turn.items)) {
          return { turns, complete: false, reason: "history_not_full_or_inconsistent" };
        }
        ids.add(turn.id);
        turns.push(turn);
        // Include a prior execution/non-quota boundary: all consecutive rejected
        // inputs must remain visible, without loading an unbounded conversation.
        if (turns.length > 1 && (!isQuotaFailure(turn) || hasRecordedProgress(turn))) {
          return { turns, complete: true };
        }
      }
      if (response.nextCursor === null) return { turns, complete: true };
      if (!response.data.length || !response.nextCursor || cursors.has(response.nextCursor)) {
        return { turns, complete: false, reason: "history_cursor_cycle" };
      }
      cursor = response.nextCursor;
      cursors.add(cursor);
    }
    return { turns, complete: false, reason: "history_page_limit" };
  } catch {
    return { turns, complete: false, reason: "full_history_unavailable" };
  }
}
