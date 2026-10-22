const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { classifyRecoveryHistory, replayText, replayAttachments, pastedTxtReferences, matchesReplayedInput,
  recoveryDiagnostic, MAX_INPUT_BYTES } = require("../dist/inputRecovery");
const { materializePastedTxt, verifyPastedTxtBeforeSend,
  MAX_PASTED_TXT_BYTES } = require("../dist/recoveryAttachments");

const ID = "0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3";
const NOW = 1900000000000;

async function fixture(t, text = "# Offline implementation\nDo not connect CTP.\n") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pasted-txt-"));
  const folder = path.join(home, "attachments", ID);
  const file = path.join(folder, "Pasted text.txt");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(file, text);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, file, folder };
}
const message = (file, request = "Please execute the offline plan.") =>
  "# Context from my IDE setup:\n\n" +
  "# Files pasted by the user:\n\n" +
  '## "# Optimizer 数据调研计划——本机 Codex 执行版…": ' + file + "\n\n" +
  "## My request:\n" + request + "\n";
const classify = (text, options = {}) => classifyRecoveryHistory({ complete: true, turns: [{
  id: "failed", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" },
  itemsView: "full", items: [{ type: "userMessage", id: "item-1",
    content: [{ type: "text", text, text_elements: [] }] }],
}] }, { nowMs: NOW, ...options });

test("real Codex-style pasted TXT keeps original body and yields a separate official UI attachment", async t => {
  const originalContent = "计划第一步：只读调查\n" + "数据不可修改\n".repeat(3000);
  const { home, file } = await fixture(t, originalContent);
  const original = message(file, "Read-only and CTP separately authorized.");
  const captured = await materializePastedTxt(classify(original), undefined, home);
  const digest = crypto.createHash("sha256").update(originalContent).digest("hex");
  assert.equal(captured.action, "needs_review"); // Do not change default policy.
  assert.equal(captured.reason, "user_only_history_requires_review");
  assert.equal(captured.attachmentIntegrity.status, "verified");
  assert.equal(captured.pastedTxtSnapshots[0].sha256, digest);
  assert.equal(captured.pastedTxtSnapshots[0].byteLength, Buffer.byteLength(originalContent));
  assert.equal(captured.pastedTxtSnapshots[0].text, originalContent);
  const dispatchedText = replayText(captured);
  assert.equal(dispatchedText, original);
  assert.ok(!dispatchedText.includes(originalContent));
  assert.deepEqual(replayAttachments(captured), [{
    label: "# Optimizer 数据调研计划——本机 Codex 执行版…",
    path: file, fsPath: file, isPastedText: true,
  }]);
  assert.equal(await verifyPastedTxtBeforeSend({ ...captured, action: "replay_input" }, home), true);
  const diagnostics = JSON.stringify(recoveryDiagnostic(captured));
  assert.ok(!diagnostics.includes(file));
  assert.ok(!diagnostics.includes("计划第一步"));
  assert.equal(recoveryDiagnostic(captured).attachmentIntegrity.bytes, Buffer.byteLength(originalContent));
  assert.equal(recoveryDiagnostic(captured).replayableText, true);
});

test("captured original is never silently replaced after the TXT file changes", async t => {
  const { home, file } = await fixture(t, "Offline only: ORIGINAL");
  const original = classify(message(file));
  const pinned = await materializePastedTxt(original, undefined, home);
  await fs.writeFile(file, "Offline only: MODIFIED");
  const altered = await materializePastedTxt(classify(message(file)), pinned, home);
  assert.equal(altered.action, "needs_review");
  assert.equal(altered.reason, "attachment_modified");
  assert.equal(altered.pastedTxtSnapshots[0].text, "Offline only: ORIGINAL");
  assert.equal(replayText(altered), undefined);
  assert.equal(await verifyPastedTxtBeforeSend({ ...pinned, action: "replay_input" }, home), false);
});

test("missing TXT is retained as unresolved rather than replaying its path alone", async t => {
  const { home, file } = await fixture(t);
  await fs.unlink(file);
  const candidate = await materializePastedTxt(classify(message(file)), undefined, home);
  assert.equal(candidate.reason, "attachment_missing");
  assert.equal(candidate.action, "needs_review");
  assert.equal(replayText(candidate), undefined);
  assert.equal(candidate.inputs[0].content[0].text, message(file));
});

test("missing after snapshot blocks send even if an old approval was saved", async t => {
  const { home, file } = await fixture(t, "PINNED");
  const pinned = await materializePastedTxt(classify(message(file)), undefined, home);
  await fs.unlink(file);
  const failed = await materializePastedTxt(classify(message(file)), { ...pinned,
    action: "replay_input", approval: { action: "replay_input", fingerprint: pinned.fingerprint } }, home);
  assert.equal(failed.action, "needs_review");
  assert.equal(failed.reason, "attachment_missing");
  assert.equal(replayText(failed), undefined);
});

test("arbitrary outside, traversal, relative or wrong-session TXT paths are never opened", async t => {
  const { home, file } = await fixture(t);
  for (const ref of ["/tmp/secrets.txt", "../secrets.txt", path.join(home, "outside.txt"),
    path.join(home, "attachments", ID, "..", ID, "Pasted text.txt") + "/../x.txt"]) {
    const p = await materializePastedTxt(classify(message(ref)), undefined, home);
    assert.equal(p.reason, "attachment_unsafe_reference");
    assert.equal(replayText(p), undefined);
  }
  const regular = await materializePastedTxt(classify(message(file)), undefined, home);
  assert.equal(regular.attachmentIntegrity.status, "verified");
});

test("a symlink to a non-attachment file is rejected", async t => {
  const { home, file } = await fixture(t);
  const target = path.join(home, "private.txt");
  await fs.writeFile(target, "private material");
  await fs.unlink(file);
  await fs.symlink(target, file);
  const p = await materializePastedTxt(classify(message(file)), undefined, home);
  assert.equal(p.reason, "attachment_unsafe_reference");
  assert.equal(replayText(p), undefined);
});

test("unknown pasted type or incomplete attachment block is not treated as plain text", async t => {
  const { home, file } = await fixture(t);
  for (const source of [
    message(file).replace(".txt", ".pdf"),
    message(file).replace("## My request:", "## Unknown heading:"),
    message(file).replace("# Files pasted by the user:", "# Files pasted by the user:\n# Files pasted by the user:"),
  ]) {
    const p = await materializePastedTxt(classify(source), undefined, home);
    assert.equal(p.reason, "attachment_invalid_reference");
    assert.equal(replayText(p), undefined);
  }
});

test("non-UTF8 pasted text and embedded NUL are blocked", async t => {
  const { home, file } = await fixture(t);
  for (const buffer of [Buffer.from([0xff, 0xfe, 0x00]), Buffer.from("A\0B")]) {
    await fs.writeFile(file, buffer);
    const p = await materializePastedTxt(classify(message(file)), undefined, home);
    assert.equal(p.reason, "attachment_unsupported_encoding");
  }
});

test("oversized pasted TXT cannot be silently shortened", async t => {
  const { home, file } = await fixture(t);
  await fs.writeFile(file, "X".repeat(MAX_PASTED_TXT_BYTES + 1));
  const p = await materializePastedTxt(classify(message(file)), undefined, home);
  assert.equal(p.reason, "attachment_too_large");
  assert.equal(replayText(p), undefined);
});

test("pasted TXT expansion obeys total maximum IPC message budget", async t => {
  const { home, file } = await fixture(t, "Z".repeat(MAX_PASTED_TXT_BYTES));
  const source = message(file, "X".repeat(MAX_INPUT_BYTES - MAX_PASTED_TXT_BYTES - 20));
  const p = await materializePastedTxt(classify(source), undefined, home);
  assert.equal(p.reason, "attachment_too_large");
  assert.equal(replayText(p), undefined);
});

test("multiple pasted TXT references preserve original body and attachment order", async t => {
  const { home, file, folder } = await fixture(t, "FIRST CONTENT");
  const second = path.join(folder, "Second plan.txt");
  await fs.writeFile(second, "SECOND CONTENT");
  const src = message(file).replace("\n\n## My request:", "\n## \"second\": " + second + "\n\n## My request:");
  const p = await materializePastedTxt(classify(src), undefined, home);
  const dispatched = replayText(p);
  assert.equal(dispatched, src);
  assert.equal(p.attachmentIntegrity.count, 2);
  assert.deepEqual(replayAttachments(p).map(item => item.path), [file, second]);
  assert.ok(!dispatched.includes("FIRST CONTENT"));
  assert.ok(!dispatched.includes("SECOND CONTENT"));
});

test("own replay lineage recognizes original text plus separately attached TXT after accepted dispatch", async t => {
  const { home, file } = await fixture(t, "work requirements");
  const pinned = await materializePastedTxt(classify(message(file)), undefined, home);
  const actual = replayText(pinned);
  const observed = { itemsView: "full", items: [{ type: "userMessage",
    content: [{ type: "text", text: actual, text_elements: [] }],
    attachments: replayAttachments(pinned),
  }] };
  assert.equal(matchesReplayedInput(observed, pinned), true);
  observed.items[0].content[0].text = actual + "changed";
  assert.equal(matchesReplayedInput(observed, pinned), false);
  observed.items[0].content[0].text = actual;
  observed.items[0].attachments[0].path += ".changed";
  assert.equal(matchesReplayedInput(observed, pinned), false);
});

test("ordinary no-attachment inputs still replay byte-for-byte and need no filesystem", async () => {
  const original = "  only offline implementation \n";
  const p = await materializePastedTxt(classify(original));
  assert.equal(replayText(p), original);
  assert.equal(await verifyPastedTxtBeforeSend({ ...p, action: "replay_input" }), true);
});


test("repeated quota rejection reuses the same TXT metadata without inlining or duplication", async t => {
  const { home, file } = await fixture(t, "READ-ONLY SESSION PLAN");
  const original = message(file);
  const first = await materializePastedTxt(classify(original), undefined, home);
  const second = await materializePastedTxt(classify(replayText(first)), first, home);
  assert.equal(second.attachmentIntegrity.status, "verified");
  assert.equal(replayText(second), original);
  assert.deepEqual(replayAttachments(second), replayAttachments(first));
  assert.ok(!replayText(second).includes("READ-ONLY SESSION PLAN"));
  await fs.writeFile(file, "DIFFERENT PLAN");
  const changed = await materializePastedTxt(classify(original), first, home);
  assert.equal(changed.reason, "attachment_modified");
  assert.equal(replayText(changed), undefined);
});

test("unknown metadata spelling with a Codex attachments path cannot bypass checks", async () => {
  const bad = "Pasted attachment: /home/example/.codex/attachments/" +
    ID + "/Pasted text.txt\nPlease run it.";
  assert.equal(pastedTxtReferences(bad).present, true);
  assert.equal(replayText(classify(bad)), undefined);
});


test("pasted Markdown stays a separate attachment and the original prompt remains unchanged", async t => {
  const markdown = [
    "# Optimizer 数据调研计划",
    "",
    "## 目标",
    "只读调查，不修改原始数据。",
    "",
    "- 先检查行情路径",
    "- 再检查 Barra 因子",
    "",
    "执行要求：先收集路径，再根据缺口提问。",
    "",
  ].join("\n");
  const { home, file } = await fixture(t, markdown);
  const original = message(file, "请执行这份调研计划。");
  const plan = await materializePastedTxt(classify(original), undefined, home);
  const replay = replayText({ ...plan, action: "replay_input" });
  assert.equal(replay, original);
  assert.deepEqual(replayAttachments(plan), [{
    label: "# Optimizer 数据调研计划——本机 Codex 执行版…",
    path: file, fsPath: file, isPastedText: true,
  }]);
  assert.ok(!replay.includes(markdown));
  assert.ok(!replay.includes("verified contents of pasted TXT attachment"));
});


test("remote G3 authorization: IDE open-tab path to old TXT is context, not a new attachment", async () => {
  const ordinary = [
    "# Context from my IDE setup:",
    "",
    "## Open tabs:",
    "- MAX_SCORE_REVIEW.md: doc/MAX_SCORE_REVIEW.md",
    "- Pasted text.txt: /home/test/.codex/attachments/" + ID + "/Pasted text.txt",
    "",
    "## My request:",
    "授权G3",
    "",
  ].join("\n");
  assert.deepEqual(pastedTxtReferences(ordinary),
    { present: false, references: [], labels: [] });
  const first = await materializePastedTxt(classify(ordinary, {
    policy: "replayStableUserOnly",
  }));
  assert.equal(first.reason, "waiting_for_stable_full_history");
  assert.equal(first.attachmentIntegrity, undefined);
  const ready = await materializePastedTxt(classify(ordinary, {
    policy: "replayStableUserOnly", previous: first,
    nowMs: NOW + 20_000,
  }), first);
  assert.equal(ready.action, "replay_input");
  assert.equal(ready.reason, "opt_in_stable_user_only_history");
  assert.equal(replayText(ready), ordinary);
  assert.deepEqual(replayAttachments(ready), []);
  assert.equal(await verifyPastedTxtBeforeSend(ready), true);
});

test("ordinary request quoting a Codex TXT path does not cause a filesystem read", async () => {
  const plain = "## My request:\nRead-only check of path " +
    "/home/test/.codex/attachments/" + ID + "/Pasted text.txt\n";
  assert.equal(pastedTxtReferences(plain).present, false);
  assert.equal(replayText(classify(plain)), plain);
  const saved = await materializePastedTxt(classify(plain));
  assert.equal(saved.reason, "user_only_history_requires_review");
  assert.equal(saved.attachmentIntegrity, undefined);
});

test("an empty official pasted-files section closed by My request has no attachments", async () => {
  const source = [
    "# Context from my IDE setup:",
    "",
    "# Files pasted by the user:",
    "",
    "## My request:",
    "授权G3",
    "",
  ].join("\n");
  assert.deepEqual(pastedTxtReferences(source),
    { present: false, references: [], labels: [] });
  assert.equal(replayText(await materializePastedTxt(classify(source))), source);
});

test("unknown explicit pasted metadata and malformed official blocks still fail closed", async () => {
  for (const source of [
    "Pasted attachment: /home/test/.codex/attachments/" + ID +
      "/Pasted text.txt\nRun plan",
    "# Attached files:\n\n- /home/test/.codex/attachments/" + ID +
      "/Pasted text.txt\n\n## My request:\nRun plan\n",
    "# Files pasted by the user:\n\n## \"plan\": /tmp/outside.txt\n\n## My request:\nRun",
    "# Files pasted by the user:\n\n## \"plan\": /tmp/other.pdf\n\n## My request:\nRun",
    "# Files pasted by the user:\n\n## Unknown heading:\nRun",
    "# Files pasted by the user:\n", // Truncated/incomplete section
  ]) {
    const first = await materializePastedTxt(classify(source));
    assert.equal(first.reason, "attachment_invalid_reference", source);
    assert.equal(first.action, "needs_review");
    assert.equal(replayText(first), undefined);
  }
});

test("old invalid_reference from an ordinary IDE path can reclassify after install", async () => {
  const text = "# Context from my IDE setup:\n\n## Open tabs:\n" +
    "- Pasted text.txt: /home/test/.codex/attachments/" +
    ID + "/Pasted text.txt\n\n## My request:\n授权G3\n";
  const earlier = {
    ...classify(text), stale: true, action: "needs_review",
    reason: "attachment_invalid_reference",
    attachmentIntegrity: { status: "invalid_reference", count: 0, bytes: 0 },
  };
  const fresh = await materializePastedTxt(classify(text, {
    nowMs: NOW + 12_000, previous: earlier, policy: "replayStableUserOnly",
  }), earlier);
  assert.equal(fresh.reason, "waiting_for_stable_full_history");
  const after = await materializePastedTxt(classify(text, {
    nowMs: NOW + 24_000, previous: fresh, policy: "replayStableUserOnly",
  }), fresh);
  assert.equal(after.action, "replay_input");
  assert.equal(replayText(after), text);
  assert.deepEqual(replayAttachments(after), []);
});
