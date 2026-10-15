const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  tryAcquireQuotaPrimerSendLock,
} = require("../dist/quotaPrimerLock.js");

test("serializes primer sends across extension hosts sharing global storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-"));
  const output = { appendLine() {} };

  try {
    const first = await tryAcquireQuotaPrimerSendLock(root, output);
    assert.ok(first);

    const second = await tryAcquireQuotaPrimerSendLock(root, output);
    assert.equal(second, undefined);

    await first.release();

    const third = await tryAcquireQuotaPrimerSendLock(root, output);
    assert.ok(third);
    await third.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent windows acquire at most one send lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locks = await Promise.all(Array.from({ length: 12 }, () => tryAcquireQuotaPrimerSendLock(root, { appendLine() {} })));
  assert.equal(locks.filter(Boolean).length, 1);
  await locks.find(Boolean).release();
});

test("never evicts a live extension host merely because dispatch exceeded stale age", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-live-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = { appendLine() {} };
  const first = await tryAcquireQuotaPrimerSendLock(root, output);
  const lockPath = path.join(root, "quota-primer-send.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
  const old = Date.now() - 10 * 60_000;
  await fs.writeFile(ownerPath, JSON.stringify({ ...owner, acquiredAtMs: old }));
  await fs.utimes(lockPath, old / 1000, old / 1000);
  assert.equal(await tryAcquireQuotaPrimerSendLock(root, output), undefined);
  await first.release();
});

test("dead stale owner is retired once and its delayed release cannot delete successor", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = { appendLine() {} };
  const original = await tryAcquireQuotaPrimerSendLock(root, output);
  const lockPath = path.join(root, "quota-primer-send.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
  const old = Date.now() - 10 * 60_000;
  await fs.writeFile(ownerPath, JSON.stringify({ ...owner, pid: 2_147_483_647, acquiredAtMs: old }));
  await fs.utimes(lockPath, old / 1000, old / 1000);
  const attempts = await Promise.all(Array.from({ length: 12 }, () => tryAcquireQuotaPrimerSendLock(root, output)));
  assert.equal(attempts.filter(Boolean).length, 1);
  const successor = attempts.find(Boolean);
  await original.release();
  assert.equal(await tryAcquireQuotaPrimerSendLock(root, output), undefined);
  const retired = (await fs.readdir(root)).filter((name) => name.startsWith("quota-primer-send.lock.retired-"));
  assert.equal(retired.length, 1);
  await successor.release();
  const next = await tryAcquireQuotaPrimerSendLock(root, output);
  assert.ok(next);
  await next.release();
});

test("unknown fresh owner fails closed while abandoned stale creation can be recovered", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-incomplete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "quota-primer-send.lock");
  await fs.mkdir(lockPath);
  const output = { appendLine() {} };
  assert.equal(await tryAcquireQuotaPrimerSendLock(root, output), undefined);
  const old = Date.now() - 10 * 60_000;
  await fs.utimes(lockPath, old / 1000, old / 1000);
  const recovered = await tryAcquireQuotaPrimerSendLock(root, output);
  assert.ok(recovered);
  await recovered.release();
});

test("a creator paused before its owner write cannot overwrite or remove a successor", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-primer-lock-paused-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "quota-primer-send.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  let notifyPaused;
  const paused = new Promise((resolve) => { notifyPaused = resolve; });
  let resumeCreator;
  const resume = new Promise((resolve) => { resumeCreator = resolve; });
  const writeFile = fs.writeFile;
  let intercepted = false;
  t.mock.method(fs, "writeFile", async (target, ...args) => {
    if (target === ownerPath && !intercepted) {
      intercepted = true;
      notifyPaused();
      await resume;
    }
    return writeFile(target, ...args);
  });
  const output = { appendLine() {} };
  const originalAttempt = tryAcquireQuotaPrimerSendLock(root, output);
  await paused;
  const old = Date.now() - 10 * 60_000;
  await fs.utimes(lockPath, old / 1000, old / 1000);
  const successor = await tryAcquireQuotaPrimerSendLock(root, output);
  assert.ok(successor);
  const successorOwner = await fs.readFile(ownerPath, "utf8");
  resumeCreator();
  await assert.rejects(originalAttempt, { code: "EEXIST" });
  assert.equal(await fs.readFile(ownerPath, "utf8"), successorOwner);
  assert.equal(await tryAcquireQuotaPrimerSendLock(root, output), undefined);
  await successor.release();
});
