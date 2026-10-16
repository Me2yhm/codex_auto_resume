const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControllerHarness } = require("./helpers/controllerHarness.js");
const { QUOTA_PRIMER_STATE_KEY } = require("../dist/quotaPrimerState.js");
const { PRIMER_THREAD_SOURCE } = require("../dist/primerIdentity.js");
const { writeQuotaPrimerSendJournal } = require("../dist/quotaPrimerSendJournal.js");

const NOW = 1_900_000_000_000;

function thread(id, changes = {}) {
  return { id, cwd: "/workspace", preview: "Real work", updatedAt: NOW / 1000, recencyAt: null, source: "vscode", status: { type: "inactive" }, ...changes };
}

async function discovery(t, options = {}) {
  t.mock.method(Date, "now", () => NOW);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-discovery-"));
  if (options.journal) await writeQuotaPrimerSendJournal(root, { version: 1, updatedAtMs: NOW, ...options.journal });
  const h = createControllerHarness({
    globalStoragePath: root,
    workspaceFolders: options.workspaceFolders,
    workspaceValues: options.workspaceValues,
    globalValues: { [QUOTA_PRIMER_STATE_KEY]: options.state ?? {} },
    request(method, params) {
      if (method === "account/rateLimits/read") {
        return { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 }, secondary: null, rateLimitReachedType: null } };
      }
      assert.equal(method, "thread/list");
      assert.deepEqual(params.sourceKinds, ["vscode"]);
      assert.equal(params.archived, false);
      const pages = params.cwd ? options.exact : options.broad;
      const page = pages?.[params.cursor ?? "first"];
      return page ?? { data: [], nextCursor: null };
    },
  });
  t.after(async () => { h.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await h.controller.ensureClient();
  return h;
}

test("exact discovery skips current, historical, and metadata Primer threads sharing the work cwd", async (t) => {
  const work = thread("real-work", { name: "Implement Quota Primer integration" });
  const h = await discovery(t, {
    state: { threadId: "current-primer", knownPrimerThreadIds: ["previous-primer"] },
    exact: { first: { data: [thread("current-primer"), thread("previous-primer"), thread("unrecorded-primer", { source: { custom: PRIMER_THREAD_SOURCE } }), work], nextCursor: null } },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, work.id);
  assert.ok(h.requests.every((request) => request.params.cwd));
});

test("exact discovery searches later pages after filtering Primer and unrelated workspace entries", async (t) => {
  const h = await discovery(t, {
    state: { knownPrimerThreadIds: ["previous-primer"] },
    exact: {
      first: { data: [thread("previous-primer"), thread("unrelated", { cwd: "/outside" })], nextCursor: "exact-page-2" },
      "exact-page-2": { data: [thread("real-work")], nextCursor: null },
    },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, "real-work");
  assert.ok(h.requests.some((request) => request.params.cursor === "exact-page-2"));
  assert.ok(h.requests.every((request) => request.params.limit === 20));
});

test("broad discovery paginates, checks workspace descendants, and excludes historical and metadata Primers", async (t) => {
  const h = await discovery(t, {
    state: { knownPrimerThreadIds: ["previous-primer"] },
    broad: {
      first: { data: [thread("previous-primer"), thread("metadata-primer", { threadSource: PRIMER_THREAD_SOURCE }), thread("neighbor", { cwd: "/workspace-other" })], nextCursor: "broad-page-2" },
      "broad-page-2": { data: [thread("work-descendant", { cwd: "/workspace/nested/repo" })], nextCursor: null },
    },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, "work-descendant");
  assert.ok(h.requests.some((request) => !request.params.cwd && request.params.cursor === "broad-page-2"));
  assert.ok(h.requests.filter((request) => !request.params.cwd).every((request) => request.params.limit === 100));
});

test("same-host journal history and unresolved dispatch identity override a stale per-window Primer state", async (t) => {
  const h = await discovery(t, {
    state: { threadId: "local-primer" },
    journal: {
      threadId: "other-window-current",
      knownPrimerThreadIds: ["host-historical-primer"],
      pending: { threadId: "other-window-pending", sentAtMs: NOW - 1000 },
    },
    exact: { first: { data: [thread("local-primer"), thread("other-window-current"), thread("host-historical-primer"), thread("other-window-pending"), thread("real-work")], nextCursor: null } },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, "real-work");
});

test("a fresh broad workspace thread takes precedence over an exact match outside the recent window", async (t) => {
  const h = await discovery(t, {
    exact: { first: { data: [thread("stale-exact", { updatedAt: (NOW - 481 * 60_000) / 1000 })], nextCursor: null } },
    broad: { first: { data: [thread("recent-descendant", { cwd: "/workspace/nested" })], nextCursor: null } },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, "recent-descendant");
});

for (const mode of ["exact", "broad"]) {
  test(`${mode} discovery rejects Linux prefix siblings and path escapes while preserving case sensitivity`, async (t) => {
    const h = await discovery(t, {
      workspaceFolders: ["/work/Project"],
      [mode]: { first: { data: [
        thread("prefix-sibling", { cwd: "/work/Project-backup" }),
        thread("path-escape", { cwd: "/work/Project/../outside" }),
        thread("different-case", { cwd: "/work/project/nested" }),
        thread("valid-descendant", { cwd: "/work/Project/nested" }),
      ], nextCursor: null } },
    });
    assert.equal((await h.controller.findMostRecentThread()).id, "valid-descendant");
  });
}

for (const mode of ["exact", "broad"]) {
  test(`${mode} discovery uses Windows drive containment with normalized separators and insensitive case`, async (t) => {
    const h = await discovery(t, {
      workspaceFolders: ["C:\\Users\\Me\\Repo\\"],
      [mode]: { first: { data: [
        thread("prefix-sibling", { cwd: "C:\\Users\\Me\\Repo-backup" }),
        thread("different-drive", { cwd: "D:\\Users\\Me\\Repo\\src" }),
        thread("path-escape", { cwd: "C:\\Users\\Me\\Repo\\..\\outside" }),
        thread("valid-windows-descendant", { cwd: "c:/users/me/repo/src" }),
      ], nextCursor: null } },
    });
    assert.equal((await h.controller.findMostRecentThread()).id, "valid-windows-descendant");
  });
}

for (const mode of ["exact", "broad"]) {
  test(`${mode} discovery distinguishes UNC shares and sibling directory prefixes`, async (t) => {
    const h = await discovery(t, {
      workspaceFolders: ["\\\\SERVER\\Share\\Repo"],
      [mode]: { first: { data: [
        thread("different-share", { cwd: "\\\\server\\OtherShare\\Repo\\src" }),
        thread("prefix-sibling", { cwd: "\\\\server\\share\\Repository" }),
        thread("valid-unc-descendant", { cwd: "\\\\server\\share\\repo\\src" }),
      ], nextCursor: null } },
    });
    assert.equal((await h.controller.findMostRecentThread()).id, "valid-unc-descendant");
  });
}

test("multiple workspace folders accept a descendant of any open root", async (t) => {
  const h = await discovery(t, {
    workspaceFolders: ["/work/one", "/work/two"],
    broad: { first: { data: [thread("other-workspace", { cwd: "/work/three" }), thread("second-root", { cwd: "/work/two/nested" })], nextCursor: null } },
  });
  assert.equal((await h.controller.findMostRecentThread()).id, "second-root");
});

test("discovery with no workspace folders does not select an unrelated conversation", async (t) => {
  const h = await discovery(t, { workspaceFolders: [] });
  assert.equal(await h.controller.findMostRecentThread(), undefined);
  assert.equal(h.requests.length, 0);
});

for (const phase of ["armed", "dispatch-pending", "verifying", "pending"]) {
  test(`a restored ${phase} record for a historical Primer is cleared before automatic work recovery`, async (t) => {
    const record = phase === "pending"
      ? { threadId: "old-primer", cwd: "/workspace", turnId: "old-primer-turn", observedAtMs: NOW - 60_000, reason: "usageLimitExceeded" }
      : { threadId: "old-primer", cwd: "/workspace", armedAtMs: NOW - 60_000, resetAtMs: NOW + 3_600_000, reason: "usageLimitExceeded",
        ...(phase === "dispatch-pending" ? { dispatchPending: { beforeTurnId: "old-primer-turn", sentAtMs: NOW - 10_000 } } : {}),
        ...(phase === "verifying" ? { resumeTurnId: "old-resumed-primer-turn", resumeStartedAtMs: NOW - 10_000 } : {}),
      };
    const key = phase === "pending" ? "codexAutoResume.pendingQuotaCandidate" : "codexAutoResume.armed";
    const h = await discovery(t, {
      // Only the shared journal knows this ID, as can happen in another window.
      journal: { knownPrimerThreadIds: ["old-primer"] },
      workspaceValues: { [key]: record },
    });
    await h.tick();
    assert.equal(h.context.workspaceState.get(key), undefined);
    assert.equal(h.sends.length, 0);
    assert.equal(h.requests.some((request) => request.method === "thread/turns/list"), false);
  });
}

test("clearing a historical Primer pending candidate preserves a simultaneous armed real work conversation", async (t) => {
  const realArmed = { threadId: "real-work", cwd: "/workspace", armedAtMs: NOW - 60_000, resetAtMs: NOW + 3_600_000, reason: "usageLimitExceeded", interruptedTurnId: "real-work-quota-turn" };
  const h = await discovery(t, {
    journal: { knownPrimerThreadIds: ["old-primer"] },
    workspaceValues: {
      "codexAutoResume.armed": realArmed,
      "codexAutoResume.pendingQuotaCandidate": { threadId: "old-primer", cwd: "/workspace", turnId: "old-primer-turn", observedAtMs: NOW - 60_000, reason: "usageLimitExceeded" },
    },
  });
  await h.tick();
  assert.deepEqual(h.context.workspaceState.get("codexAutoResume.armed"), realArmed);
  assert.equal(h.context.workspaceState.get("codexAutoResume.pendingQuotaCandidate"), undefined);
  assert.equal(h.sends.length, 0);
});
