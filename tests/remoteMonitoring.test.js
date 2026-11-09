const assert = require("node:assert/strict");
const test = require("node:test");
const { createControllerHarness, createMemoryMemento } = require("./helpers/controllerHarness");

const NOW = 1_900_000_000_000;
const OUTSIDE = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const ARMED = "codexAutoResume.armed";

function quota(blocked = true) {
  return { ordinaryUsageAllowed: !blocked, rateLimits: {
    limitId: null, limitName: null,
    primary: { usedPercent: blocked ? 100 : 0, windowDurationMins: 300, resetsAt: (NOW + 3600000) / 1000 },
    secondary: null, rateLimitReachedType: blocked ? "workspace_member_credits_depleted" : null,
  } };
}

function thread(id, updatedAt, cwd = "/workspace") {
  return { id, cwd, updatedAt, source: { category: "remote" },
    status: { type: "inactive" }, preview: "SECRET_THREAD_PREVIEW" };
}
function turn(threadId, quotaFailed) {
  return { id: "turn-" + threadId, status: quotaFailed ? "failed" : "completed",
    error: quotaFailed ? {
      codexErrorInfo: "usageLimitExceeded", message: "SECRET_BACKEND_ERROR", additionalDetails: "SECRET_DETAILS",
    } : null,
    itemsView: "summary", items: [{ type: "userMessage", text: "SECRET_USER_MESSAGE" }],
  };
}

function createRemoteHarness(t, { sourceFilteredHasTarget = true, visible = true, tabRoute = "remote" } = {}) {
  const previews = [];
  const state = createMemoryMemento();
  const h = createControllerHarness({
    workspaceState: state,
    request(method, params) {
      if (method === "account/rateLimits/read") return quota();
      if (method === "thread/list") return { data: params.sourceKinds
        ? [thread(OUTSIDE, NOW / 1000), ...(sourceFilteredHasTarget
          ? [thread(TARGET, NOW / 1000 - 1)] : [])]
        : [thread(OUTSIDE, NOW / 1000), thread(TARGET, NOW / 1000 - 1)],
        nextCursor: null };
      if (method === "thread/turns/list") return { data: [
        turn(params.threadId, params.threadId === TARGET),
      ], nextCursor: null };
      throw new Error("unexpected " + method);
    },
  });
  h.vscode.env = { remoteName: "ssh-remote" };
  h.vscode.extensions = { getExtension: () => undefined };
  h.vscode.window.tabGroups = { all: [{ tabs: visible ? [{
    input: Object.assign(new h.vscode.TabInputCustom(TARGET), {
      uri: { scheme: "openai-codex", authority: "route", path: "/" + tabRoute + "/" + TARGET },
    }),
  }] : [] }] };
  h.vscode.workspace.openTextDocument = async doc => { previews.push(doc); return doc; };
  h.vscode.window.showTextDocument = async () => {};
  t.after(() => h.dispose());
  return { ...h, previews, state };
}

test("Remote SSH current-window thread is not hidden by newer unrelated workspace conversation", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t, { sourceFilteredHasTarget: true });
  await h.tick();
  assert.equal(h.state.get(ARMED)?.threadId, TARGET, h.logs.join("\n"));
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.get("codexAutoResume.pendingQuotaCandidate"), undefined);
});

test("Remote SSH custom editor can identify a quota-failed thread even when sourceKinds vscode excludes it", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t, { sourceFilteredHasTarget: false });
  await h.tick();
  assert.equal(h.state.get(ARMED)?.threadId, TARGET, h.logs.join("\n"));
  assert.ok(h.requests.some(r => r.method === "thread/list" && !r.params.sourceKinds));
  assert.equal(h.sends.length, 0);
});

test("a remote conversation without window ownership evidence is not adopted from an unfiltered source search", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t, { sourceFilteredHasTarget: false, visible: false });
  await h.tick();
  assert.equal(h.state.get(ARMED), undefined);
  assert.equal(h.state.get("codexAutoResume.recoveryBacklog.v1"), undefined);
  assert.equal(h.sends.length, 0);
  assert.equal(h.requests.filter(r => r.method === "thread/list" && !r.params.sourceKinds).length, 0);
});

test("read-only Remote monitoring diagnostic reveals source/cwd/quota mismatches without user text or state writes", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t, { sourceFilteredHasTarget: false });
  const beforeState = JSON.stringify(h.state.keys());
  await h.controller.diagnoseMonitoring();
  assert.equal(h.previews.length, 1);
  const content = h.previews[0].content;
  const report = JSON.parse(content);
  assert.equal(report.extension.remoteName, "ssh-remote");
  assert.equal(report.extension.windowCodexEditorTabs, 1);
  assert.equal(report.quota.status, "blocked");
  assert.equal(report.scans.length, 2);
  assert.equal(report.scans[0].visibleTabMatches, 0);
  assert.equal(report.scans[1].visibleTabMatches, 1);
  const matching = report.scans[1].candidates.find(x => x.currentWindowEditorTab);
  assert.equal(matching.latestStatus, "failed");
  assert.equal(matching.structuredQuotaError, "usageLimitExceeded");
  assert.equal(matching.workspaceMatch, true);
  assert.ok(report.interpretation.some(x => x.includes("source filter")));
  for (const sensitive of [TARGET, OUTSIDE, "/workspace", "SECRET_THREAD_PREVIEW",
    "SECRET_BACKEND_ERROR", "SECRET_DETAILS", "SECRET_USER_MESSAGE"]) {
    assert.equal(content.includes(sensitive), false, "diagnostics must not expose " + sensitive);
  }
  assert.equal(JSON.stringify(h.state.keys()), beforeState);
  assert.equal(h.state.updates.length, 0);
  assert.equal(h.sends.length, 0);
});

test("diagnostics flag missing reset timestamp without pretending monitoring has armed a thread", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t);
  h.setRequestHandler((method, params) => {
    if (method === "account/rateLimits/read") {
      const response = quota();
      response.rateLimits.primary.resetsAt = null;
      return response;
    }
    if (method === "thread/list") return { data: [thread(TARGET, NOW / 1000)], nextCursor: null };
    if (method === "thread/turns/list") return { data: [turn(params.threadId, true)], nextCursor: null };
    throw new Error("unexpected method");
  });
  await h.controller.diagnoseMonitoring();
  const report = JSON.parse(h.previews.at(-1).content);
  assert.equal(report.quota.hasFutureResetTime, false);
  assert.ok(report.interpretation.some(x => x.includes("without a future reset")));
  assert.equal(h.state.get(ARMED), undefined);
  assert.equal(h.sends.length, 0);
});


test("read-only monitoring explains pre-turn quota rejection without synthesizing a recovery target", async t => {
  t.mock.method(Date, "now", () => NOW);
  const h = createRemoteHarness(t);
  h.setRequestHandler((method, params) => {
    if (method === "account/rateLimits/read") return quota();
    if (method === "thread/list") return { data: [thread(TARGET, NOW / 1000)], nextCursor: null };
    if (method === "thread/turns/list") return { data: [turn(params.threadId, false)], nextCursor: null };
    throw new Error("unexpected method");
  });
  await h.controller.diagnoseMonitoring();
  const report = JSON.parse(h.previews.at(-1).content);
  assert.equal(report.quota.status, "blocked");
  assert.ok(report.interpretation.some(x => x.includes("before a Codex turn was persisted")));
  assert.equal(h.state.get(ARMED), undefined);
  assert.equal(h.sends.length, 0);
});
