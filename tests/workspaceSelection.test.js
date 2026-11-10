const assert = require("node:assert/strict");
const test = require("node:test");
const { createControllerHarness, createMemoryMemento } = require("./helpers/controllerHarness.js");

const NOW = 1_900_000_000_000;
const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const ROOTS = ["/workspace-one", "/workspace-two", "/workspace-three", "/workspace-four", "/workspace-five"];
const ARM = "codexAutoResume.armed";

function thread(id, cwd, ageMinutes) {
  return { id, cwd, updatedAt: (NOW - ageMinutes * 60_000) / 1000,
    status: { type: "inactive" }, source: "vscode", preview: "redacted" };
}
function makeHarness(t, { rootAgeMinutes = 379, descendantAgeMinutes = 1, newestFailed = true } = {}) {
  t.mock.method(Date, "now", () => NOW);
  const state = createMemoryMemento();
  const h = createControllerHarness({
    workspaceState: state, workspaceFolders: ROOTS,
    request(method, params) {
      if (method === "account/rateLimits/read") {
        return { ordinaryUsageAllowed: false, rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: (NOW + 3600_000) / 1000 },
          secondary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: (NOW + 5 * 86400_000) / 1000 },
          rateLimitReachedType: "workspace_member_credits_depleted",
        } };
      }
      if (method === "thread/list") {
        // The exact-cwd API returns only the old, completed workspace-root
        // conversation, even though an unfiltered listing sees a quota-failed
        // thread from another root's nested .work project.
        return {
          data: params.cwd
            ? [thread(OLD, ROOTS[0], rootAgeMinutes)]
            : [
              thread(NEW, ROOTS[1] + "/.work/receiver", descendantAgeMinutes),
              thread(OLD, ROOTS[0], rootAgeMinutes),
            ].sort((a, b) => b.updatedAt - a.updatedAt),
          nextCursor: null,
        };
      }
      if (method === "thread/turns/list") {
        const interrupted = params.threadId === NEW ? newestFailed : !newestFailed;
        return { data: [{
          id: "quota-" + params.threadId,
          status: interrupted ? "failed" : "completed",
          error: interrupted ? {
            codexErrorInfo: "usageLimitExceeded", message: "Quota exceeded", additionalDetails: null,
          } : null,
          startedAt: null, completedAt: null,
        }], nextCursor: null };
      }
      throw new Error("Unexpected RPC: " + method);
    },
  });
  // The official Codex sidebar may have zero custom editor tabs.
  h.vscode.window.tabGroups = { all: [{ tabs: [] }] };
  t.after(() => h.dispose());
  return { ...h, state };
}

test("five-root workspace chooses a one-minute-old quota failure in descendant over 379-minute completed exact-cwd thread", async t => {
  const h = makeHarness(t);
  await h.tick();
  const armed = h.state.get(ARM);
  assert.equal(armed?.threadId, NEW, h.logs.join("\n"));
  assert.equal(armed?.interruptedTurnId, "quota-" + NEW);
  assert.equal(armed?.reason, "usageLimitExceeded");
  assert.equal(h.state.get("codexAutoResume.pendingQuotaCandidate"), undefined);
  assert.equal(h.sends.length, 0);
  assert.ok(h.requests.some(x => x.method === "thread/list" && Array.isArray(x.params.cwd)));
  assert.ok(h.requests.some(x => x.method === "thread/list" && !x.params.cwd));
  await h.controller.showStatus();
  assert.ok(h.vscode.messages.some(msg => msg.message.includes("Armed")), "Show Status must not say Monitoring");
});

test("newer exact-root completed conversation remains latest; do not arm an older failed descendant", async t => {
  const h = makeHarness(t, { rootAgeMinutes: 1, descendantAgeMinutes: 379, newestFailed: true });
  await h.tick();
  assert.equal(h.state.get(ARM), undefined);
  assert.equal(h.state.get("codexAutoResume.pendingQuotaCandidate"), undefined);
  assert.equal(h.sends.length, 0);
  assert.ok(h.logs.some(line => line.includes("observed thread=" + OLD) && line.includes("status=completed")));
});

test("selection never promotes a stale quota failure outside the configured recent-thread window", async t => {
  const h = makeHarness(t, { rootAgeMinutes: 9000, descendantAgeMinutes: 9001 });
  await h.tick();
  assert.equal(h.state.get(ARM), undefined);
  assert.equal(h.state.get("codexAutoResume.pendingQuotaCandidate"), undefined);
  assert.equal(h.sends.length, 0);
});
