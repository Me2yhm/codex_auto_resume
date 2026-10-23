const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createVscodeMock, loadWithMocks } = require("./helpers/controllerHarness.js");

const THREAD_ID = "existing-work-conversation";
const OWNER_ID = "official-codex-ui-owner";
const VERSIONS = { ownerDiscovery: 13, startTurn: 27 };
const PROMPT = "继续已有工作。\nResume from the confirmed interruption.";

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

async function transport(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-official-ui-regression-"));
  await fs.writeFile(path.join(root, "official-bundle.js"), options.bundleSource ?? `({"thread-owner-discovery":${VERSIONS.ownerDiscovery},"thread-follower-start-turn":${VERSIONS.startTurn}})`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vscode = createVscodeMock();
  vscode.extensions = {
    getExtension(id) {
      assert.equal(id, "openai.chatgpt");
      return { extensionPath: root, packageJSON: { main: "official-bundle.js", version: options.packageVersion ?? "fixture" } };
    },
  };
  if (options.commandError) {
    const originalExecute = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async (command, ...args) => {
      await originalExecute(command, ...args);
      if (options.commandError(command, args)) throw new Error("Remote UI mount unavailable");
    };
  }
  const logs = [];
  const output = { appendLine(line) { logs.push(line); } };
  const frames = [];
  const sockets = [];
  const connectionPaths = [];
  let ownerReads = 0;
  class FakeSocket extends EventEmitter {
    destroyed = false;
    write(buffer) {
      const length = buffer.readUInt32LE(0);
      assert.equal(buffer.length, length + 4);
      const frame = JSON.parse(buffer.subarray(4).toString("utf8"));
      frames.push(frame);
      if (frame.type !== "request") return true;
      let response = { type: "response", requestId: frame.requestId, resultType: "success", method: frame.method };
      if (frame.method === "initialize") {
        response.result = { clientId: "resume-observer" };
      } else if (frame.method === "thread-owner-discovery") {
        const owner = options.owners ? options.owners[ownerReads++] : OWNER_ID;
        response = owner
          ? { ...response, handledByClientId: owner }
          : { ...response, resultType: "error", error: options.discoveryError ?? "no-client-found" };
      } else {
        assert.equal(frame.method, "thread-follower-start-turn");
        if (options.startError) response = { ...response, resultType: "error", error: options.startError };
      }
      queueMicrotask(() => {
        const reply = encode(response);
        // The actual framing parser also has to tolerate partial socket data.
        this.emit("data", reply.subarray(0, 2));
        this.emit("data", reply.subarray(2, 7));
        this.emit("data", reply.subarray(7));
      });
      return true;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("close");
    }
  }
  const ipc = loadWithMocks(path.resolve(__dirname, "../dist/codexUiIpc.js"), {
    vscode,
    net: {
      createConnection(socketPath) {
        connectionPaths.push(socketPath);
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });
  const official = loadWithMocks(path.resolve(__dirname, "../dist/officialCodexUi.js"), {
    vscode,
    "./codexUiIpc": ipc,
  });
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { official, ipc, vscode, output, logs, frames, sockets, connectionPaths };
}

async function finishWithFakeTime(t, promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let step = 0; step < 12; step += 1) {
    // UI commands and fake socket events settle through promises rather than
    // wall-clock delays; only surfacing and owner retry delays need advancing.
    for (let microtask = 0; microtask < 30; microtask += 1) await Promise.resolve();
    if (settled) return promise;
    t.mock.timers.tick(1_000);
  }
  assert.fail("Official UI operation did not settle within its bounded retry window");
}

function followerFrame(h) {
  const starts = h.frames.filter((frame) => frame.method === "thread-follower-start-turn");
  assert.equal(starts.length, 1);
  return starts[0];
}

function assertWorkSettingsPreserved(frame, threadId = THREAD_ID) {
  assert.equal(frame.targetClientId, OWNER_ID);
  assert.equal(frame.params.conversationId, threadId);
  assert.equal(frame.params.turnStart.request.threadId, threadId);
  assert.deepEqual(frame.params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(Object.hasOwn(frame.params.turnStart.request, "model"), false);
  assert.equal(Object.hasOwn(frame.params.turnStart.request, "effort"), false);
}

test("actual official UI IPC resumes the exact conversation through its owner and inherits work settings", async (t) => {
  const h = await transport(t);
  const sent = await finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume"));
  assert.equal(sent, true);
  const discovery = h.frames.find((frame) => frame.method === "thread-owner-discovery");
  assert.deepEqual(discovery.params, { hostId: "local", conversationId: THREAD_ID });
  assert.equal(discovery.version, VERSIONS.ownerDiscovery);
  assert.equal(discovery.sourceClientId, "resume-observer");
  const start = followerFrame(h);
  assertWorkSettingsPreserved(start);
  assert.equal(start.version, VERSIONS.startTurn);
  assert.deepEqual(start.params.turnStart.request.input, [{ type: "text", text: PROMPT, text_elements: [] }]);
  assert.match(start.params.turnStart.request.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(h.frames.some((frame) => frame.method === "turn/start" || frame.method === "thread/start"), false);
  assert.deepEqual(h.vscode.executedCommands[0], { command: "chatgpt.openSidebar", args: [{ threadId: THREAD_ID }] });
  const mounted = h.vscode.executedCommands.find((command) => command.command === "vscode.openWith");
  assert.equal(mounted.args[0].path, `/local/${THREAD_ID}`);
  assert.equal(mounted.args[0].scheme, "openai-codex");
  assert.equal(mounted.args[0].authority, "route");
  assert.equal(mounted.args[1], "chatgpt.conversationEditor");
  assert.equal(h.sockets[0].destroyed, true);
});

test("startTurn discovers the official owner when none is supplied and uses the follower route", async (t) => {
  const h = await transport(t);
  const client = new h.ipc.CodexUiIpcClient(h.output, "/mock/codex-ui.sock");
  t.after(() => client.dispose());
  await client.startTurn(THREAD_ID, PROMPT, VERSIONS);
  assert.deepEqual(h.frames.map((frame) => frame.method), ["initialize", "thread-owner-discovery", "thread-follower-start-turn"]);
  assertWorkSettingsPreserved(followerFrame(h));
  assert.deepEqual(h.connectionPaths, ["/mock/codex-ui.sock"]);
});

test("a known official owner is reused without another discovery or any model override", async (t) => {
  const h = await transport(t);
  const client = new h.ipc.CodexUiIpcClient(h.output, "/mock/codex-ui.sock");
  t.after(() => client.dispose());
  await client.startTurn(THREAD_ID, PROMPT, VERSIONS, OWNER_ID);
  assert.deepEqual(h.frames.map((frame) => frame.method), ["initialize", "thread-follower-start-turn"]);
  assertWorkSettingsPreserved(followerFrame(h));
});

test("owner discovery retries a temporarily unmounted conversation and submits exactly once", async (t) => {
  const h = await transport(t, { owners: [undefined, undefined, OWNER_ID] });
  assert.equal(await finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume")), true);
  assert.equal(h.frames.filter((frame) => frame.method === "thread-owner-discovery").length, 3);
  assertWorkSettingsPreserved(followerFrame(h));
});

test("five definitive no-owner results return false without a continuation or direct writer request", async (t) => {
  const h = await transport(t, { owners: [] });
  assert.equal(await finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume")), false);
  assert.equal(h.frames.filter((frame) => frame.method === "thread-owner-discovery").length, 5);
  assert.equal(h.frames.some((frame) => /start-turn|turn\/start|thread\/start/.test(frame.method)), false);
  assert.equal(h.sockets[0].destroyed, true);
});

test("Remote sidebar/editor mounting fallbacks retain the exact target for owner dispatch", async (t) => {
  const h = await transport(t, { commandError: (command, args) => command === "vscode.openWith" || (command === "chatgpt.openSidebar" && args.length > 0) });
  assert.equal(await finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume")), true);
  assert.ok(h.vscode.executedCommands.some((command) => command.command === "chatgpt.openSidebar" && command.args.length === 0));
  assertWorkSettingsPreserved(followerFrame(h));
});

test("an explicit dedicated Primer caller may pass low-cost model/effort without surfacing work UI", async (t) => {
  const h = await transport(t);
  const primerId = "dedicated-primer-conversation";
  assert.equal(await h.official.trySendTurnThroughExistingOfficialOwner(primerId, "Reply OK", h.output, "quota-primer", { model: "luna", effort: "minimal" }), true);
  const start = followerFrame(h);
  assert.equal(start.params.conversationId, primerId);
  assert.equal(start.params.turnStart.request.threadId, primerId);
  assert.equal(start.params.turnStart.request.model, "luna");
  assert.equal(start.params.turnStart.request.effort, "minimal");
  assert.equal(start.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(h.vscode.executedCommands.length, 0);
});

test("silent owner lookup returns false only before acceptance and propagates an owner's ambiguous failure", async (t) => {
  const h = await transport(t, { startError: "request-cancelled-after-receipt" });
  await assert.rejects(h.official.trySendTurnThroughExistingOfficialOwner(THREAD_ID, PROMPT, h.output, "auto-resume"), (error) => {
    assert.equal(error.code, "request-cancelled-after-receipt");
    assert.equal(error.method, "thread-follower-start-turn");
    return true;
  });
  assertWorkSettingsPreserved(followerFrame(h));
  assert.equal(h.vscode.executedCommands.length, 0);
});

test("silent definitive no-owner lookup sends nothing and leaves the visible conversation untouched", async (t) => {
  const h = await transport(t, { owners: [] });
  assert.equal(await h.official.trySendTurnThroughExistingOfficialOwner(THREAD_ID, PROMPT, h.output, "quota-primer"), false);
  assert.equal(h.frames.some((frame) => frame.method === "thread-follower-start-turn"), false);
  assert.equal(h.vscode.executedCommands.length, 0);
});

test("the Auto Resume IPC observer declines requests to own conversations", async (t) => {
  const h = await transport(t);
  const client = new h.ipc.CodexUiIpcClient(h.output, "/mock/codex-ui.sock");
  t.after(() => client.dispose());
  await client.connect();
  h.sockets[0].emit("data", encode({ type: "client-discovery-request", requestId: "owner-probe" }));
  assert.deepEqual(h.frames.find((frame) => frame.type === "client-discovery-response"), {
    type: "client-discovery-response", requestId: "owner-probe", response: { canHandle: false },
  });
});

test("ambiguous protocol versions fail closed before any IPC request", async (t) => {
  const h = await transport(t, { bundleSource: '({"thread-owner-discovery":1,"thread-follower-start-turn":2,"nested":{"thread-follower-start-turn":3}})' });
  await assert.rejects(finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume")), /Ambiguous Codex UI IPC versions/);
  assert.equal(h.frames.length, 0);
  assert.equal(h.sockets.length, 0);
});


test("verified Codex 26.1007.21434 start-turn v2 sends TXT as separate UI context attachments", async t => {
  const h = await transport(t, {
    packageVersion: "26.1007.21434",
    bundleSource: '({"thread-owner-discovery":1,"thread-follower-start-turn":2})',
  });
  const prompt = '# Files pasted by the user:\n\n## "Optimizer plan": /home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt\n\n## My request:\nPlease run the plan.\n';
  const attachments = [{
    label: "Optimizer plan",
    path: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
    fsPath: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
    isPastedText: true,
  }];
  const sent = await finishWithFakeTime(t, h.official.sendTurnThroughOfficialCodexUi(
    THREAD_ID, prompt, h.output, "auto-resume", { attachments },
  ));
  assert.equal(sent, true);
  const start = followerFrame(h);
  assert.equal(start.version, 2);
  assert.equal(start.params.conversationId, THREAD_ID);
  assert.equal(start.params.turnStart.request.threadId, THREAD_ID);
  assert.deepEqual(start.params.turnStart.request.input, [{ type: "text", text: prompt, text_elements: [] }]);
  assert.deepEqual(start.params.turnStart.context, { inheritThreadSettings: true, attachments });
  assert.ok(!start.params.turnStart.request.input[0].text.includes("verified contents of pasted TXT"));
  assert.ok(!start.params.turnStart.request.input[0].text.includes("plan body"));
});

test("unverified Codex version refuses native TXT attachment dispatch before touching UI or IPC", async t => {
  const h = await transport(t, { packageVersion: "future-unverified-version" });
  const attachments = [{
    label: "plan",
    path: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
    fsPath: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
    isPastedText: true,
  }];
  await assert.rejects(
    h.official.sendTurnThroughOfficialCodexUi(THREAD_ID, PROMPT, h.output, "auto-resume", { attachments }),
    error => error.code === "pasted-text-attachments-unsupported",
  );
  assert.equal(h.frames.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.vscode.executedCommands.length, 0);
});

test("direct IPC client rejects attachments unless the exact inspected UI protocol is enabled", async t => {
  const h = await transport(t);
  const client = new h.ipc.CodexUiIpcClient(h.output, "/mock/codex-ui.sock");
  t.after(() => client.dispose());
  await assert.rejects(client.startTurn(THREAD_ID, PROMPT, VERSIONS, OWNER_ID, {
    attachments: [{
      label: "plan",
      path: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
      fsPath: "/home/test/.codex/attachments/0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3/Pasted text.txt",
      isPastedText: true,
    }],
  }), error => error.code === "pasted-text-attachments-unsupported");
  assert.equal(h.frames.length, 0);
});
