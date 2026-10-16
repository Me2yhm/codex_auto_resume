const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { claimWorkResume } = require("../dist/workRecoveryDispatch.js");

const REQUEST = { threadId: "exact-work-thread", beforeTurnId: "quota-failed-turn", sentAtMs: 1_900_000_000_000 };

async function storage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-work-dispatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function onlyRecordPath(root) {
  const directory = path.join(root, "work-resume-dispatches");
  const entries = await fs.readdir(directory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f\d]{64}\.json$/);
  return path.join(directory, entries[0]);
}

test("concurrent windows can claim an exact interrupted work turn only once", async (t) => {
  const root = await storage(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
    claimWorkResume(root, { ...REQUEST, sentAtMs: REQUEST.sentAtMs + index })));
  const claims = results.filter((result) => result.status === "fulfilled" && result.value.status === "claimed");
  assert.equal(claims.length, 1);
  const owner = claims[0].value;
  for (const result of results) {
    // A contender can observe the creator's incomplete file. Rejecting that
    // uncertain read is safe; it must never become a second dispatch owner.
    if (result.status === "fulfilled") assert.deepEqual(result.value.record, owner.record);
  }
  for (let window = 0; window < 12; window += 1) {
    const retry = await claimWorkResume(root, { ...REQUEST, sentAtMs: REQUEST.sentAtMs + 60_000 });
    assert.equal(retry.status, "existing");
    assert.deepEqual(retry.record, owner.record);
    assert.equal(retry.releaseUnsent, undefined);
  }
  const filename = await onlyRecordPath(root);
  if (process.platform !== "win32") assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test("different work threads and newly quota-failed turns have independent dispatch identities", async (t) => {
  const root = await storage(t);
  const requests = [
    REQUEST,
    { ...REQUEST, threadId: "another-work-thread" },
    { ...REQUEST, beforeTurnId: "next-quota-failed-turn" },
    { ...REQUEST, threadId: "thread:turn", beforeTurnId: "next" },
    { ...REQUEST, threadId: "thread", beforeTurnId: "turn:next" },
  ];
  const claims = await Promise.all(requests.map((request) => claimWorkResume(root, request)));
  assert.ok(claims.every((claim) => claim.status === "claimed"));
  assert.equal(new Set(claims.map((claim) => claim.record.token)).size, requests.length);
  assert.equal((await fs.readdir(path.join(root, "work-resume-dispatches"))).length, requests.length);
});

test("an unacknowledged dispatch survives module restart and never expires into a new send", async (t) => {
  const root = await storage(t);
  const first = await claimWorkResume(root, REQUEST);
  delete require.cache[require.resolve("../dist/workRecoveryDispatch.js")];
  const restarted = require("../dist/workRecoveryDispatch.js");
  const recovered = await restarted.claimWorkResume(root, { ...REQUEST, sentAtMs: REQUEST.sentAtMs + 365 * 86_400_000 });
  assert.equal(recovered.status, "existing");
  assert.deepEqual(recovered.record, first.record);
  assert.equal(recovered.record.sentAtMs, REQUEST.sentAtMs);
  assert.equal(recovered.releaseUnsent, undefined);
});

test("partial or invalid existing dispatches fail closed without rewriting the fence", async (t) => {
  const root = await storage(t);
  const owner = await claimWorkResume(root, REQUEST);
  const filename = await onlyRecordPath(root);
  const invalidValues = [
    "", "{", "null", "[]",
    JSON.stringify({ ...owner.record, threadId: "different-thread" }),
    JSON.stringify({ ...owner.record, beforeTurnId: "different-turn" }),
    JSON.stringify({ ...owner.record, sentAtMs: null }),
    JSON.stringify({ ...owner.record, sentAtMs: "1900000000000" }),
    JSON.stringify({ ...owner.record, token: "" }),
    JSON.stringify({ ...owner.record, token: 1 }),
    JSON.stringify({ ...owner.record, token: "unknown-token-format" }),
    JSON.stringify({ ...owner.record, unknownSchemaField: true }),
    JSON.stringify({ threadId: REQUEST.threadId, beforeTurnId: REQUEST.beforeTurnId, sentAtMs: REQUEST.sentAtMs }),
  ];
  for (const value of invalidValues) {
    await fs.writeFile(filename, value);
    await assert.rejects(claimWorkResume(root, REQUEST));
    assert.equal(await fs.readFile(filename, "utf8"), value);
  }
});

test("filesystem failures never grant a dispatch claim", async (t) => {
  const root = await storage(t);
  const storageFile = path.join(root, "storage-is-a-file");
  await fs.writeFile(storageFile, "not a directory");
  await assert.rejects(claimWorkResume(storageFile, REQUEST));

  const blockedDirectory = path.join(root, "work-resume-dispatches");
  await fs.writeFile(blockedDirectory, "not a directory");
  await assert.rejects(claimWorkResume(root, REQUEST));
  assert.equal(await fs.readFile(blockedDirectory, "utf8"), "not a directory");
});

test("invalid identities and non-finite dispatch timestamps fail before claiming", async (t) => {
  const root = await storage(t);
  for (const request of [
    { ...REQUEST, threadId: "" },
    { ...REQUEST, threadId: 1 },
    { ...REQUEST, beforeTurnId: "" },
    { ...REQUEST, beforeTurnId: null },
    { ...REQUEST, sentAtMs: NaN },
    { ...REQUEST, sentAtMs: Infinity },
  ]) await assert.rejects(claimWorkResume(root, request));
  assert.deepEqual(await fs.readdir(root), []);
});

test("a known unsent claim releases once and delayed releases preserve its successor", async (t) => {
  const root = await storage(t);
  const first = await claimWorkResume(root, REQUEST);
  assert.equal(first.status, "claimed");
  await Promise.all(Array.from({ length: 20 }, () => first.releaseUnsent()));
  const successor = await claimWorkResume(root, REQUEST);
  assert.equal(successor.status, "claimed");
  assert.notEqual(successor.record.token, first.record.token);
  await first.releaseUnsent();
  const observed = await claimWorkResume(root, REQUEST);
  assert.equal(observed.status, "existing");
  assert.deepEqual(observed.record, successor.record);
});

test("releaseUnsent checks its token and cannot delete a replacement owner's record", async (t) => {
  const root = await storage(t);
  const first = await claimWorkResume(root, REQUEST);
  const filename = await onlyRecordPath(root);
  const replacement = { ...first.record, sentAtMs: REQUEST.sentAtMs + 60_000, token: randomUUID() };
  await fs.writeFile(filename, JSON.stringify(replacement));
  await first.releaseUnsent();
  await first.releaseUnsent();
  const observed = await claimWorkResume(root, REQUEST);
  assert.equal(observed.status, "existing");
  assert.deepEqual(observed.record, replacement);
});

test("releaseUnsent leaves a corrupt record protected and tolerates an already absent file", async (t) => {
  const root = await storage(t);
  const first = await claimWorkResume(root, REQUEST);
  const filename = await onlyRecordPath(root);
  await fs.writeFile(filename, "{");
  await assert.rejects(first.releaseUnsent());
  assert.equal(await fs.readFile(filename, "utf8"), "{");
  await fs.unlink(filename);
  await first.releaseUnsent();
  await first.releaseUnsent();
  assert.equal((await claimWorkResume(root, REQUEST)).status, "claimed");
});
