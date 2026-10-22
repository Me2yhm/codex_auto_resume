const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");

const { resolveOfficialPastedTxtPath, realPastedTxtIsConfined } =
  require("../dist/pastedTxtPath");
const { classifyRecoveryHistory, replayText, replayAttachments } =
  require("../dist/inputRecovery");
const { materializePastedTxt, verifyPastedTxtBeforeSend } =
  require("../dist/recoveryAttachments");

const ID = "cfe468d2-bbed-4543-9d64-f01697f97142";
const WIN_ROOT = "C:\\Users\\example\\.codex\\attachments";
const WIN_MIXED = "C:\\Users\\example\\.codex/attachments/" + ID + "/Pasted text.txt";

function candidate(rawPath) {
  const text = "# Files pasted by the user:\n\n## \"Test plan\": " +
    rawPath + "\n\n## My request:\nRun the plan.\n";
  const history = { complete: true, turns: [{
    id: "quota-failed", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" },
    itemsView: "full", items: [{
      id: "item-1", type: "userMessage",
      content: [{ type: "text", text, text_elements: [] }],
    }],
  }] };
  return { text, history };
}

test("Windows mixed slash path stays within the expected two-level Codex attachment directory", () => {
  const normalized = resolveOfficialPastedTxtPath(WIN_MIXED, WIN_ROOT, path.win32);
  assert.ok(normalized);
  assert.equal(normalized.filesystemPath,
    path.win32.join(WIN_ROOT, ID, "Pasted text.txt"));
  assert.equal(normalized.sessionId, ID);
  assert.equal(normalized.sessionDirectory, path.win32.join(WIN_ROOT, ID));
  assert.equal(realPastedTxtIsConfined(
    WIN_ROOT, path.win32.join(WIN_ROOT, ID, "Pasted text.txt"), ID, path.win32), true);
  assert.equal(realPastedTxtIsConfined(
    WIN_ROOT, path.win32.join(WIN_ROOT, "other", "Pasted text.txt"), ID, path.win32), false);
});

test("Windows normalization does not grant access to traversal, different drives or ADS", () => {
  const invalid = [
    "C:\\Users\\example\\.codex/attachments/" + ID + "/../" + ID + "/Pasted text.txt",
    "C:\\Users\\example\\.codex/attachments/" + ID + "/./Pasted text.txt",
    "C:\\Users\\example\\.codex/attachments/" + ID + "/../../secret.txt",
    "C:\\Users\\example\\.codex/attachments/another/" + ID + "/Pasted text.txt",
    "C:\\Users\\example\\.codex/attachments/" + ID + "/Pasted text.txt:stream",
    "D:\\Users\\example\\.codex/attachments/" + ID + "/Pasted text.txt",
    "\\\\server\\share\\.codex\\attachments\\" + ID + "\\Pasted text.txt",
    "..\\attachments\\" + ID + "\\Pasted text.txt",
    "C:\\Users\\example\\.codex/attachments/" + ID + "/another.log",
  ];
  for (const source of invalid) {
    assert.equal(resolveOfficialPastedTxtPath(source, WIN_ROOT, path.win32), undefined, source);
  }
});

test("POSIX rejects escaping and only resolves two-level managed TXT files", () => {
  const root = "/home/test/.codex/attachments";
  const good = root + "/" + ID + "/Pasted text.txt";
  assert.equal(resolveOfficialPastedTxtPath(good, root, path.posix)?.filesystemPath, good);
  for (const source of ["/tmp/private.txt", root + "/" + ID + "/../" + ID + "/Pasted text.txt",
    root + "/" + ID + "/nested/Pasted text.txt", root + "/" + ID + "/bad.txt:stream",
    "./" + ID + "/Pasted text.txt"]) {
    assert.equal(resolveOfficialPastedTxtPath(source, root, path.posix), undefined, source);
  }
});

test("real Windows host: mixed-separator official pasted TXT is read, pinned, and replayed with unchanged metadata",
  { skip: process.platform !== "win32" }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-windows-pasted-"));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const root = path.join(home, "attachments");
    const folder = path.join(root, ID);
    const file = path.join(folder, "Pasted text.txt");
    await fs.mkdir(folder, { recursive: true });
    const body = "# Windows pasted plan\nRead-only tasks.\n".repeat(1200);
    await fs.writeFile(file, body, "utf8");

    const mixed = file.replace(/\\attachments\\/i, "/attachments/")
      .replace(/\\Pasted text\.txt$/i, "/Pasted text.txt");
    assert.notEqual(mixed, file);
    const input = candidate(mixed);
    const first = classifyRecoveryHistory(input.history,
      { nowMs: 1_900_000_000_000, policy: "replayStableUserOnly" });
    const captured = await materializePastedTxt(first, undefined, home);
    assert.equal(captured.attachmentIntegrity.status, "verified");
    assert.equal(captured.pastedTxtSnapshots[0].sourcePath, mixed);
    assert.equal(captured.pastedTxtSnapshots[0].byteLength, Buffer.byteLength(body));
    assert.equal(captured.pastedTxtSnapshots[0].text, body);
    const stable = await materializePastedTxt(classifyRecoveryHistory(input.history, {
      nowMs: 1_900_000_020_000, previous: captured, policy: "replayStableUserOnly",
    }), captured, home);
    assert.equal(stable.action, "replay_input");
    assert.equal(replayText(stable), input.text);
    assert.deepEqual(replayAttachments(stable), [{
      label: "Test plan", path: mixed, fsPath: mixed, isPastedText: true,
    }]);
    assert.equal(await verifyPastedTxtBeforeSend(stable, home), true);
    await fs.writeFile(file, body.replace("Windows", "Changed"), "utf8");
    assert.equal(await verifyPastedTxtBeforeSend(stable, home), false);
  });
