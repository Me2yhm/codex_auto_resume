const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RecoveryCoordinator, readRecoveryPriority } = require("../dist/recoveryCoordination.js");

const output = { appendLine() {} };

async function storage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-recovery-registry-"));
  const coordinators = [];
  t.after(async () => {
    for (const coordinator of coordinators) {
      await coordinator.clear().catch(() => {});
      coordinator.dispose();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    directory: path.join(root, "recovery-coordination"),
    create(workspaceId, options) {
      const coordinator = new RecoveryCoordinator(root, workspaceId, output, options);
      coordinators.push(coordinator);
      return coordinator;
    },
  };
}

async function eventually(predicate) {
  const deadline = process.hrtime.bigint() + 2_000_000_000n;
  do {
    if (await predicate()) return;
    await new Promise(setImmediate);
  } while (process.hrtime.bigint() < deadline);
  assert.fail("timed out waiting for coordination update");
}

test("missing registry is clear and independent windows publish all recovery phases", async (t) => {
  const shared = await storage(t);
  assert.deepEqual(await readRecoveryPriority(shared.root), { status: "clear", records: [] });
  const first = shared.create("workspace-one");
  const second = shared.create("workspace-two");
  await Promise.all([
    first.set({ phase: "pending", threadId: "work-one" }),
    second.set({ phase: "armed", threadId: "work-two" }),
  ]);
  let priority = await readRecoveryPriority(shared.root);
  assert.equal(priority.status, "active");
  assert.deepEqual(priority.records.map((record) => record.phase).sort(), ["armed", "pending"]);
  assert.deepEqual(priority.records.map((record) => record.workspaceId).sort(), ["workspace-one", "workspace-two"]);
  await first.set({ phase: "verifying", threadId: "work-one" });
  await second.clear();
  priority = await readRecoveryPriority(shared.root);
  assert.equal(priority.status, "active");
  assert.equal(priority.records.length, 1);
  assert.equal(priority.records[0].phase, "verifying");
  assert.equal(priority.records[0].threadId, "work-one");
});

test("crashed host lease blocks through grace then expires without deleting a renewed path", async (t) => {
  const shared = await storage(t);
  const coordinator = shared.create("remote-workspace");
  await coordinator.set({ phase: "armed", threadId: "interrupted-work" });
  const [lease] = (await readRecoveryPriority(shared.root)).records;
  assert.equal((await readRecoveryPriority(shared.root, { nowMs: lease.expiresAtMs + 30_000 })).status, "active");
  assert.equal((await readRecoveryPriority(shared.root, { nowMs: lease.expiresAtMs + 30_001 })).status, "clear");
  assert.ok((await fs.readdir(shared.directory)).includes(`${lease.instanceId}.json`));
  await coordinator.set({ phase: "verifying", threadId: "interrupted-work" });
  assert.equal((await readRecoveryPriority(shared.root)).status, "active");
});

test("heartbeat renews during long network or completion waits and clear prevents resurrection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_900_000_000_000;
  t.mock.method(Date, "now", () => now);
  const shared = await storage(t);
  const coordinator = shared.create("workspace");
  await coordinator.set({ phase: "verifying", threadId: "slow-resume" });
  const initial = (await readRecoveryPriority(shared.root)).records[0];
  now += 15_000;
  t.mock.timers.tick(15_000);
  await eventually(async () => (await readRecoveryPriority(shared.root)).records[0]?.updatedAtMs === now);
  const renewed = (await readRecoveryPriority(shared.root)).records[0];
  assert.equal(renewed.expiresAtMs - initial.expiresAtMs, 15_000);
  t.mock.timers.tick(15_000);
  await coordinator.clear();
  now += 300_000;
  t.mock.timers.tick(300_000);
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
});

test("queued updates followed by disposal cannot resurrect a closed window", async (t) => {
  const shared = await storage(t);
  const closing = shared.create("closing-workspace");
  const open = shared.create("open-workspace");
  await open.set({ phase: "armed", threadId: "still-waiting" });
  const writes = [
    closing.set({ phase: "pending", threadId: "closing-work" }),
    closing.set({ phase: "armed", threadId: "closing-work" }),
    closing.set({ phase: "verifying", threadId: "closing-work" }),
  ];
  closing.dispose();
  await Promise.all(writes);
  await eventually(async () => {
    const priority = await readRecoveryPriority(shared.root);
    return priority.status === "active" && priority.records.length === 1 && priority.records[0].threadId === "still-waiting";
  });
  await closing.set({ phase: "armed", threadId: "must-not-return" });
  assert.equal((await readRecoveryPriority(shared.root)).records.length, 1);
});

test("incomplete atomic temp writes are ignored but malformed published registrations fail closed", async (t) => {
  const shared = await storage(t);
  await fs.mkdir(shared.directory);
  await fs.writeFile(path.join(shared.directory, "incomplete.json.random.tmp"), "{");
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
  await fs.writeFile(path.join(shared.directory, "damaged.json"), "{");
  assert.equal((await readRecoveryPriority(shared.root)).status, "unknown");
  await fs.writeFile(path.join(shared.directory, "damaged.json"), JSON.stringify({ phase: "armed", threadId: "work" }));
  assert.equal((await readRecoveryPriority(shared.root)).status, "unknown");
});

test("corrupt registry directory and unexpected nested entries fail closed", async (t) => {
  const shared = await storage(t);
  await fs.writeFile(shared.directory, "damaged directory");
  assert.equal((await readRecoveryPriority(shared.root)).status, "unknown");
  await fs.rm(shared.directory);
  await fs.mkdir(path.join(shared.directory, "nested.json"), { recursive: true });
  assert.equal((await readRecoveryPriority(shared.root)).status, "unknown");
});

test("a failed publication does not poison later recovery or cleanup updates", async (t) => {
  const shared = await storage(t);
  const coordinator = shared.create("workspace");
  await fs.writeFile(shared.directory, "broken registry");
  await assert.rejects(coordinator.set({ phase: "armed", threadId: "retained-work" }));
  assert.equal((await readRecoveryPriority(shared.root)).status, "unknown");
  await fs.rm(shared.directory);
  await coordinator.set({ phase: "verifying", threadId: "retained-work" });
  assert.equal((await readRecoveryPriority(shared.root)).records[0].phase, "verifying");
  await coordinator.clear();
  assert.equal((await readRecoveryPriority(shared.root)).status, "clear");
});
