const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");
const { PRIMER_THREAD_SOURCE, isPrimerThread } = require("../dist/primerIdentity.js");
const { MAX_KNOWN_PRIMER_THREAD_IDS, QUOTA_PRIMER_STATE_KEY, migrateQuotaPrimerState } = require("../dist/quotaPrimerState.js");
const { readQuotaPrimerSendJournal, writeQuotaPrimerSendJournal } = require("../dist/quotaPrimerSendJournal.js");

function thread(id, changes = {}) {
  return { id, cwd: "/workspace", preview: "", updatedAt: Date.now() / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" }, ...changes };
}

test("legacy Primer state migrates its current conversation into an idempotent historical exclusion list", () => {
  const legacy = { threadId: "legacy-primer", model: "luna", primary: { trackedResetAtMs: 123 } };
  const migrated = migrateQuotaPrimerState(legacy);
  assert.ok(migrated.knownPrimerThreadIds.includes("legacy-primer"));
  assert.equal(migrated.threadId, "legacy-primer");
  assert.equal(migrated.model, legacy.model);
  assert.deepEqual(migrated.primary, legacy.primary);
  assert.equal(legacy.knownPrimerThreadIds, undefined, "migration does not mutate persisted input");
  assert.deepEqual(migrateQuotaPrimerState(migrated), migrated);
  assert.deepEqual(migrateQuotaPrimerState().knownPrimerThreadIds, []);
});

test("Primer history is bounded and deduplicated while retaining the current conversation", () => {
  assert.equal(MAX_KNOWN_PRIMER_THREAD_IDS, 256);
  const history = Array.from({ length: MAX_KNOWN_PRIMER_THREAD_IDS + 30 }, (_, index) => `primer-${index}`);
  const migrated = migrateQuotaPrimerState({
    threadId: "current-primer",
    knownPrimerThreadIds: [...history, history[10], "current-primer", "current-primer"],
  });
  assert.equal(migrated.knownPrimerThreadIds.length, MAX_KNOWN_PRIMER_THREAD_IDS);
  assert.equal(new Set(migrated.knownPrimerThreadIds).size, MAX_KNOWN_PRIMER_THREAD_IDS);
  assert.ok(migrated.knownPrimerThreadIds.includes("current-primer"));
});

test("current, historical, and host-journal Primer IDs are excluded without metadata", () => {
  const state = { threadId: "current", knownPrimerThreadIds: ["previous-one", "previous-two"] };
  for (const id of ["current", "previous-one", "previous-two", "another-window-primer"]) {
    assert.equal(isPrimerThread(thread(id), state, ["another-window-primer"]), true);
  }
  assert.equal(isPrimerThread(thread("real-work"), state, ["another-window-primer"]), false);
});

for (const metadata of [
  { threadSource: PRIMER_THREAD_SOURCE },
  { originator: PRIMER_THREAD_SOURCE },
  { source: PRIMER_THREAD_SOURCE },
  { source: { custom: PRIMER_THREAD_SOURCE } },
  { source: { threadSource: PRIMER_THREAD_SOURCE } },
  { source: { originator: PRIMER_THREAD_SOURCE } },
  { source: { serviceName: PRIMER_THREAD_SOURCE } },
]) {
  test(`trusted Primer metadata identifies an unrecorded conversation: ${JSON.stringify(metadata)}`, () => {
    assert.equal(isPrimerThread(thread("unrecorded-primer", metadata)), true);
  });
}

test("ordinary work is never excluded solely for a Primer name, preview, or prompt", () => {
  for (const changes of [
    { name: "Codex Auto Resume - Quota Primer" },
    { name: "Implement Primer identity tests" },
    { preview: "Quota window primer. Reply exactly OK. Do not inspect files, run tools, or modify anything." },
    { name: PRIMER_THREAD_SOURCE, preview: PRIMER_THREAD_SOURCE },
  ]) {
    assert.equal(isPrimerThread(thread("real-work", changes)), false);
  }
});

test("untrusted text and near-matching source markers do not classify real work as a Primer", () => {
  for (const changes of [
    { threadSource: `${PRIMER_THREAD_SOURCE}-documentation` },
    { originator: `work-about-${PRIMER_THREAD_SOURCE}` },
    { source: `discussion of ${PRIMER_THREAD_SOURCE}` },
    { source: { preview: PRIMER_THREAD_SOURCE } },
    { source: { name: PRIMER_THREAD_SOURCE } },
    { source: { custom: { preview: PRIMER_THREAD_SOURCE } } },
    { source: [PRIMER_THREAD_SOURCE] },
    { source: null },
  ]) {
    assert.equal(isPrimerThread(thread("real-work", changes)), false);
  }
});

async function primerController(t, state, journal) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-reset-history-"));
  if (journal) await writeQuotaPrimerSendJournal(root, { version: 1, updatedAtMs: Date.now(), ...journal });
  const h = createControllerHarness({
    modulePath: path.resolve(__dirname, "../dist/quotaPrimerController.js"),
    exportName: "QuotaPrimerController",
    globalStoragePath: root,
    globalValues: { [QUOTA_PRIMER_STATE_KEY]: state },
  });
  t.after(async () => { h.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return Object.assign(h, { root });
}

test("Reset Primer Thread clears reuse targets while preserving local and same-host historical identities", async (t) => {
  const h = await primerController(t,
    { threadId: "local-current", threadCwd: "/workspace", model: "luna", effort: "low", knownPrimerThreadIds: ["local-history"] },
    { threadId: "host-current", knownPrimerThreadIds: ["host-history"] },
  );
  await h.controller.resetPrimerThread();
  const state = h.context.globalState.get(QUOTA_PRIMER_STATE_KEY);
  const result = await readQuotaPrimerSendJournal(h.root);
  assert.equal(result.status, "ready");
  assert.equal(state.threadId, undefined);
  assert.equal(result.journal.threadId, undefined);
  for (const id of ["local-current", "local-history", "host-current", "host-history"]) {
    assert.ok(state.knownPrimerThreadIds.includes(id), `local history retains ${id}`);
    assert.ok(result.journal.knownPrimerThreadIds.includes(id), `host history retains ${id}`);
    assert.equal(isPrimerThread(thread(id), state), true);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.sends.length, 0);
});

test("Reset Primer Thread preserves unresolved host dispatch confirmation and its conversation exclusion", async (t) => {
  const pending = { threadId: "inflight-primer", beforeTurnId: "previous-primer-turn", turnId: "accepted-primer-turn", sentAtMs: Date.now() - 10_000 };
  const h = await primerController(t,
    { threadId: "local-current", knownPrimerThreadIds: ["older-primer"] },
    { threadId: "inflight-primer", pending },
  );
  await h.controller.resetPrimerThread();
  const result = await readQuotaPrimerSendJournal(h.root);
  const state = h.context.globalState.get(QUOTA_PRIMER_STATE_KEY);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.journal.pending, pending);
  assert.ok(result.journal.knownPrimerThreadIds.includes(pending.threadId));
  assert.ok(state.knownPrimerThreadIds.includes(pending.threadId));
  assert.ok(state.pendingConfirmation);
  assert.equal(state.pendingConfirmation.sentAtMs, pending.sentAtMs);
  assert.equal(h.sends.length, 0);
});

test("Reset Primer Thread migrates unresolved 0.3.9 local confirmation when no host journal exists", async (t) => {
  const pending = { turnId: "accepted-legacy-primer-turn", sentAtMs: Date.now() - 10_000 };
  const h = await primerController(t, { threadId: "legacy-primer", pendingConfirmation: pending });
  await h.controller.resetPrimerThread();
  const result = await readQuotaPrimerSendJournal(h.root);
  const state = h.context.globalState.get(QUOTA_PRIMER_STATE_KEY);
  assert.equal(result.status, "ready");
  assert.ok(result.journal.pending);
  assert.equal(result.journal.pending.threadId, "legacy-primer");
  assert.equal(result.journal.pending.turnId, pending.turnId);
  assert.equal(result.journal.pending.sentAtMs, pending.sentAtMs);
  assert.equal(state.pendingConfirmation.turnId, pending.turnId);
  assert.ok(state.knownPrimerThreadIds.includes("legacy-primer"));
  assert.equal(h.sends.length, 0);

  h.setRequestHandler((method, params) => {
    if (method === "account/rateLimits/read") {
      return { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 }, secondary: null, rateLimitReachedType: null } };
    }
    assert.equal(method, "thread/turns/list");
    assert.equal(params.threadId, "legacy-primer");
    return { data: [{ id: pending.turnId, status: "interrupted", error: null, startedAt: null, completedAt: null }], nextCursor: null };
  });
  await h.controller.primeNow();
  assert.equal(h.sends.length, 0);
  assert.equal(h.requests.some((request) => request.method === "turn/start" || request.method === "thread/start"), false);
  assert.ok(h.requests.some((request) => request.method === "thread/turns/list"));
  const afterPrime = await readQuotaPrimerSendJournal(h.root);
  assert.equal(afterPrime.journal.pending.turnId, pending.turnId);
  assert.ok(h.vscode.messages.some((message) => message.type === "warning" && /awaiting confirmation/.test(message.message)));
});

test("saving a replacement Primer target keeps the previous target in local history", async (t) => {
  const h = await primerController(t, { threadId: "old-primer" });
  await h.controller.saveState({ threadId: "replacement-primer" });
  const state = h.context.globalState.get(QUOTA_PRIMER_STATE_KEY);
  assert.equal(state.threadId, "replacement-primer");
  assert.ok(state.knownPrimerThreadIds.includes("old-primer"));
  assert.ok(state.knownPrimerThreadIds.includes("replacement-primer"));
});


test("a window publishes its legacy history to the host before another cache performs discovery", async (t) => {
  const h = await primerController(t, { threadId: "legacy-X", knownPrimerThreadIds: ["older-X"] },
    { threadId: "host-Y" });
  h.setRequestHandler(method => {
    assert.equal(method, "account/rateLimits/read");
    return { ordinaryUsageAllowed: false, rateLimits: null };
  });
  await h.controller.primeNow();
  const host = await readQuotaPrimerSendJournal(h.root);
  assert.equal(host.journal.threadId, "host-Y");
  for (const id of ["legacy-X", "older-X", "host-Y"]) assert.ok(host.journal.knownPrimerThreadIds.includes(id));
  assert.equal(h.sends.length, 0);
  const other = createControllerHarness({ globalStoragePath: h.root,
    request(method) {
      assert.equal(method, "thread/list");
      return { data: [thread("legacy-X"), thread("work")], nextCursor: null };
    } });
  t.after(other.dispose);
  await other.controller.ensureClient();
  assert.equal((await other.controller.findMostRecentThread()).id, "work");
});
