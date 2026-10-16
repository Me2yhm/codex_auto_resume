const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

function createMemoryMemento(initial = {}) {
  const values = new Map(Object.entries(initial));
  const updates = [];
  return {
    updates,
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    async update(key, value) {
      updates.push({ key, value });
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

function createVscodeMock(options = {}) {
  const configuration = {
    "codexAutoResume.enabled": true,
    ...options.configuration,
  };
  const statusBars = [];
  const messages = [];
  const commands = [];
  const fileUri = (fsPath) => ({
    fsPath,
    path: fsPath,
    scheme: "file",
    with(changes) {
      return { ...this, ...changes };
    },
  });

  return {
    configuration,
    statusBars,
    messages,
    executedCommands: commands,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    Uri: { file: fileUri },
    window: {
      createStatusBarItem() {
        const item = { text: "", tooltip: "", show() {}, dispose() {} };
        statusBars.push(item);
        return item;
      },
      async showInformationMessage(message) {
        messages.push({ type: "information", message });
      },
      async showWarningMessage(message) {
        messages.push({ type: "warning", message });
      },
    },
    workspace: {
      workspaceFolders: (options.workspaceFolders ?? ["/workspace"]).map((folder) => ({
        uri: fileUri(folder),
      })),
      getConfiguration(section) {
        return {
          get(key, fallback) {
            const name = section ? `${section}.${key}` : key;
            return Object.hasOwn(configuration, name) ? configuration[name] : fallback;
          },
          async update(key, value) {
            configuration[section ? `${section}.${key}` : key] = value;
          },
        };
      },
    },
    commands: {
      async executeCommand(command, ...args) {
        commands.push({ command, args });
      },
    },
  };
}

// Loading is synchronous, so the process-wide hook never remains installed
// while a test awaits controller work. Each controller gets its own VS Code
// and transport mocks without requiring a running VS Code extension host.
function loadWithMocks(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  const originalLoad = Module._load;
  const originalCacheEntry = require.cache[resolved];
  delete require.cache[resolved];
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
    if (originalCacheEntry) require.cache[resolved] = originalCacheEntry;
  }
}

function createControllerHarness(options = {}) {
  const vscode = createVscodeMock(options);
  const context = {
    workspaceState: options.workspaceState ?? createMemoryMemento(options.workspaceValues),
    globalState: options.globalState ?? createMemoryMemento(options.globalValues),
    globalStorageUri: vscode.Uri.file(options.globalStoragePath ?? "/unused-test-storage"),
    subscriptions: [],
  };
  const logs = [];
  const output = { appendLine: (line) => logs.push(line), show() {}, dispose() {} };
  const requests = [];
  const sends = [];
  const clients = [];
  let requestHandler = options.request;

  class FakeRpcClient extends EventEmitter {
    constructor() {
      super();
      this.isRunning = false;
      this.hasNetworkEnvironmentBridge = true;
      clients.push(this);
    }
    async start() {
      this.isRunning = true;
    }
    async request(method, params, timeoutMs) {
      requests.push({ method, params, timeoutMs });
      if (!requestHandler) throw new Error(`Unexpected RPC request: ${method}`);
      return requestHandler(method, params, timeoutMs);
    }
    dispose() {
      this.isRunning = false;
    }
  }

  const send = (transport) => async (threadId, prompt, outputChannel, logPrefix, overrides) => {
    const request = { transport, threadId, prompt, logPrefix, overrides };
    sends.push(request);
    return options.send ? options.send(request) : true;
  };
  const exports = loadWithMocks(
    options.modulePath ?? path.resolve(__dirname, "../../dist/autoResumeController.js"),
    {
      vscode,
      ...(options.realCoordination ? {} : {
        "./workRecoveryDispatch": {
          readWorkResumeDispatch: async (_path, record) => ({ ...record, sentAtMs: Date.now(), token: "mock-dispatch" }),
          claimWorkResume: async (_path, record) => ({ status: "claimed", record: { ...record, token: "mock-dispatch" }, releaseUnsent: async () => {} }),
        },
        "./recoveryCoordination": {
          readRecoveryPriority: async () => ({ status: "clear", records: [] }),
          RecoveryCoordinator: class {
            async set() {}
            async clear() {}
            dispose() {}
          },
        },
      }),
      "./codexRpcClient": { CodexRpcClient: FakeRpcClient },
      "./codexLocator": { resolveCodexExecutable: () => "/mock/codex" },
      "./officialCodexUi": {
        sendTurnThroughOfficialCodexUi: send("official-ui"),
        trySendTurnThroughExistingOfficialOwner: send("existing-owner"),
      },
      ...options.mocks,
    },
  );
  const Controller = exports[options.exportName ?? "AutoResumeController"];
  const controller = new Controller(context, output);
  // Poll explicitly in tests; leaving real timers armed would hide duplicate
  // attempts and keep the Node test worker alive after assertions finish.
  controller.scheduleNextTick = () => {};

  return {
    controller,
    context,
    vscode,
    output,
    logs,
    requests,
    sends,
    clients,
    tick: () => controller.tick(),
    setRequestHandler(handler) {
      requestHandler = handler;
    },
    dispose: () => controller.dispose(),
  };
}

module.exports = { createControllerHarness, createMemoryMemento, createVscodeMock, loadWithMocks };
