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
