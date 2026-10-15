const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createControllerHarness } = require('./helpers/controllerHarness');
const { RecoveryCoordinator } = require('../dist/recoveryCoordination');
const { readQuotaPrimerSendJournal, writeQuotaPrimerSendJournal, QUOTA_PRIMER_SEND_JOURNAL_FILE } = require('../dist/quotaPrimerSendJournal');
const { tryAcquireQuotaPrimerSendLock } = require('../dist/quotaPrimerLock');

const STATE = 'codexAutoResume.quotaPrimer.state';
const NOW = 1_900_000_000_000;
const DURATION = 300 * 60_000;
const completed = { id: 'primer-new', status: 'completed', error: null, startedAt: NOW / 1000, completedAt: NOW / 1000 };
const previous = { id: 'primer-before', status: 'completed', error: null, startedAt: null, completedAt: null };
const model = { id: 'luna', model: 'luna', displayName: 'Luna', hidden: false, isDefault: true,
  defaultReasoningEffort: 'minimal', supportedReasoningEfforts: [{ reasoningEffort: 'minimal', description: '' }] };

function quota(ordinaryUsageAllowed = true, usedPercent = 0, reset = NOW + DURATION) {
  return { ordinaryUsageAllowed, rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: reset / 1000 },
    secondary: null, rateLimitReachedType: null } };
}
function dormantState() {
  return { threadId: 'primer-thread', primary: { trackedResetAtMs: NOW - 120_000,
    probeObservedAtMs: NOW - 60_000, probeResetAtMs: NOW - 60_000 + DURATION } };
}
async function storage(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'primer-safety-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function harness(t, directory, options = {}) {
  const clock = options.clock ?? { now: NOW };
  t.mock.method(Date, 'now', () => clock.now);
  let currentQuota = options.quota;
  const h = createControllerHarness({
    modulePath: path.resolve(__dirname, '../dist/quotaPrimerController.js'), exportName: 'QuotaPrimerController',
    globalStoragePath: directory, realCoordination: true,
    globalValues: { [STATE]: options.state ?? dormantState() },
    configuration: { 'codexAutoResume.quotaPrimer.enabled': true, 'codexAutoResume.quotaPrimer.jitterSeconds': 0,
      'codexAutoResume.quotaPrimer.graceSeconds': 0 },
    request: async (method, params) => {
      const custom = await options.request?.(method, params, h);
      if (custom !== undefined) return custom;
      if (method === 'account/rateLimits/read') {
        if (currentQuota instanceof Error) throw currentQuota;
        return currentQuota ?? quota(true, 0, clock.now + DURATION);
      }
      if (method === 'thread/list') return { data: [], nextCursor: null };
      if (method === 'model/list') return { data: [model], nextCursor: null };
      if (method === 'thread/turns/list') return { data: [previous], nextCursor: null };
      if (method === 'thread/resume' || method === 'thread/name/set') return {};
      if (method === 'thread/start') return { thread: { id: 'created-primer', source: 'codex-auto-resume-primer' }, model: 'luna' };
      if (method === 'turn/start') return { turn: completed };
      throw new Error(`Unexpected ${method}`);
    },
    send: options.send,
  });
  h.controller.waitForUiPrimerTurn = options.wait ?? (async () => completed);
  h.controller.waitForMotionSample = async (observedAtMs) => { clock.now = Math.max(clock.now, observedAtMs + 15_000); };
  h.setQuota = (value) => { currentQuota = value; };
  h.clock = clock;
  t.after(h.dispose);
  return h;
}
async function until(predicate) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Expected asynchronous checkpoint');
}

for (const phase of ['pending', 'armed', 'verifying']) {
  test(`another workspace ${phase} lease suppresses automatic and manual Primer`, async (t) => {
    const directory = await storage(t);
    const h = harness(t, directory);
    const coordinator = new RecoveryCoordinator(directory, '/other-workspace', { appendLine() {} });
    t.after(() => coordinator.dispose());
    await coordinator.set({ phase, threadId: 'real-work' });
    await h.tick();
    await h.controller.primeNow();
    assert.equal(h.sends.length, 0);
    assert.equal(h.requests.some(({ method }) => ['thread/start', 'turn/start'].includes(method)), false);
    assert.ok(h.vscode.messages.some(({ type, message }) => type === 'warning' && /recovery/.test(message)));
  });
}

test('corrupt registry and corrupt send journal fail closed', async (t) => {
  for (const corrupt of ['registry', 'journal']) {
    const directory = await storage(t);
    if (corrupt === 'registry') {
      await fs.mkdir(path.join(directory, 'recovery-coordination'));
      await fs.writeFile(path.join(directory, 'recovery-coordination', 'broken.json'), '{bad');
    } else await fs.writeFile(path.join(directory, QUOTA_PRIMER_SEND_JOURNAL_FILE), '{bad');
    const h = harness(t, directory);
    await h.tick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.requests.some(({ method }) => method === 'turn/start'), false);
  }
});

for (const unavailable of [quota(false), quota(true, 100), { rateLimits: null }, new Error('HTTP timeout')]) {
  test(`quota ${JSON.stringify(unavailable)} suppresses both commands while polling continues`, async (t) => {
    const h = harness(t, await storage(t), { quota: unavailable });
    await h.tick();
    await h.controller.primeNow();
    assert.equal(h.sends.length, 0);
    assert.equal(h.requests.filter(({ method }) => method === 'account/rateLimits/read').length, 2);
    assert.ok(h.vscode.messages.some(({ type }) => type === 'warning'));
    assert.equal(h.vscode.configuration['codexAutoResume.quotaPrimer.enabled'], true);
    assert.equal(h.context.globalState.get(STATE).threadId, 'primer-thread');
  });
}

test('post-jitter and post-model quota changes are independently checked', async (t) => {
  for (const blockAt of ['post-jitter', 'post-model']) {
    let reads = 0;
    let modelRead = false;
    const h = harness(t, await storage(t), { request(method) {
      if (method === 'model/list') modelRead = true;
      if (method === 'account/rateLimits/read') return quota(!(blockAt === 'post-jitter' ? ++reads >= 2 : modelRead));
    } });
    await h.tick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.requests.some(({ method }) => method === 'turn/start'), false);
  }
});

test('active thread on a later page and malformed activity each suppress', async (t) => {
  for (const malformed of [false, true]) {
    const h = harness(t, await storage(t), { request(method, params) {
      if (method !== 'thread/list') return;
      if (malformed) return { data: [{ id: 'work', status: null }], nextCursor: null };
      return params.cursor ? { data: [{ id: 'work', status: { type: 'active' } }], nextCursor: null }
        : { data: [{ id: 'idle', status: { type: 'inactive' } }], nextCursor: 'second-page' };
    } });
    await h.tick();
    assert.equal(h.sends.length, 0);
    if (!malformed) assert.ok(h.requests.some(({ method, params }) => method === 'thread/list' && params.cursor === 'second-page'));
  }
});

test('a fixed window discovered after jitter suppresses previously moving candidate', async (t) => {
  const clock = { now: NOW };
  let reads = 0;
  const h = harness(t, await storage(t), { clock, request(method) {
    if (method === 'account/rateLimits/read' && ++reads > 1) { clock.now = NOW + 20_000; return quota(true, 0, NOW + DURATION); }
  } });
  await h.tick();
  assert.equal(h.sends.length, 0);
});

test('last recovery check after journal persistence cancels definitely unsent intent', async (t) => {
  const directory = await storage(t);
  const coordinator = new RecoveryCoordinator(directory, '/other-workspace', { appendLine() {} });
  t.after(() => coordinator.dispose());
  const h = harness(t, directory);
  const originalUpdate = h.context.globalState.update;
  let published = false;
  h.context.globalState.update = async (key, state) => {
    await originalUpdate(key, state);
    if (state?.pendingConfirmation && !published) {
      published = true;
      await coordinator.set({ phase: 'armed', threadId: 'real-work' });
    }
  };
  await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal((await readQuotaPrimerSendJournal(directory)).journal.pending, undefined);
});

test('Disable during model selection cancels automatic send without a pending intent', async (t) => {
  const h = harness(t, await storage(t), { request: async (method, params, current) => {
    if (method === 'model/list') { await current.controller.disable(); return { data: [model], nextCursor: null }; }
  } });
  await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal((await readQuotaPrimerSendJournal(h.context.globalStorageUri.fsPath)).journal.pending, undefined);
});

test('two windows with separate Mementos send once, release lock during completion, and retain shared pending', async (t) => {
  const directory = await storage(t);
  let finish;
  let observing = false;
  const clock = { now: NOW };
  const completion = new Promise((resolve) => { finish = resolve; });
  const first = harness(t, directory, { clock, wait: () => { observing = true; return completion; } });
  const second = harness(t, directory, { clock });
  assert.notEqual(first.context.globalState, second.context.globalState);
  const ticking = first.tick();
  await until(() => observing);
  const lock = await tryAcquireQuotaPrimerSendLock(directory, { appendLine() {} });
  assert.ok(lock, 'completion wait must not retain dispatch lock');
  await lock.release();
  await second.tick();
  await second.controller.primeNow();
  assert.equal(second.sends.length, 0);
  assert.ok((await readQuotaPrimerSendJournal(directory)).journal.pending);
  finish(completed);
  await ticking;
  assert.equal(first.sends.length + second.sends.length, 1);
});

test('accepted-but-unobserved or socket-ambiguous sends remain pending across new controller caches', async (t) => {
  for (const ambiguous of [false, true]) {
    const directory = await storage(t);
    const h = harness(t, directory, { wait: async () => undefined,
      send: async () => { if (ambiguous) throw new Error('socket closed after delivery'); return true; } });
    await h.tick();
    const before = (await readQuotaPrimerSendJournal(directory)).journal.pending;
    assert.ok(before);
    h.clock.now += 24 * 60 * 60_000;
    const restarted = harness(t, directory, { clock: h.clock });
    await restarted.tick();
    assert.equal(restarted.sends.length, 0);
    assert.equal((await readQuotaPrimerSendJournal(directory)).journal.pending.sentAtMs, before.sentAtMs);
  }
});

test('legacy 0.3.9 pending state migrates, and stale older completed turn never clears ambiguous send', async (t) => {
  const directory = await storage(t);
  const state = { ...dormantState(), pendingConfirmation: { primaryResetAtMs: NOW - 120_000,
    primaryProbeObservedAtMs: NOW - 60_000, primaryProbeResetAtMs: NOW + DURATION, sentAtMs: NOW - 60_000 } };
  const h = harness(t, directory, { state });
  await h.tick();
  const journal = (await readQuotaPrimerSendJournal(directory)).journal;
  assert.ok(journal.pending);
  assert.equal(journal.pending.threadId, 'primer-thread');
  assert.equal(h.sends.length, 0);
  assert.equal(journal.pending.turnId, undefined);
});

test('direct new-thread turn initiation is journaled and releases dispatch lock before observation', async (t) => {
  const directory = await storage(t);
  let checked = false;
  const h = harness(t, directory, { state: { ...dormantState(), threadId: undefined }, request: async (method) => {
    if (method !== 'turn/start') return;
    const journal = (await readQuotaPrimerSendJournal(directory)).journal;
    assert.equal(journal.pending.threadId, 'created-primer');
    checked = true;
    return { turn: completed };
  } });
  await h.tick();
  assert.equal(checked, true);
  assert.equal(h.requests.filter(({ method }) => method === 'turn/start').length, 1);
  const lock = await tryAcquireQuotaPrimerSendLock(directory, { appendLine() {} });
  assert.ok(lock);
  await lock.release();
});

test('official idle thread status permits one dormant-window primer', async (t) => {
  const h = harness(t, await storage(t), { request(method) {
    if (method === 'thread/list') return { data: [{ id: 'work', status: { type: 'idle' } }], nextCursor: null };
  } });
  await h.tick();
  assert.equal(h.sends.length, 1);
});

test('Disable after intent persistence clears a definitely unsent journal', async (t) => {
  const directory = await storage(t);
  const h = harness(t, directory);
  const originalUpdate = h.context.globalState.update;
  let disabled = false;
  h.context.globalState.update = async (key, state) => {
    await originalUpdate(key, state);
    if (state?.pendingConfirmation && !disabled) { disabled = true; await h.controller.disable(); }
  };
  await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal((await readQuotaPrimerSendJournal(directory)).journal.pending, undefined);
});

test('manual command shares the running guard with automatic dispatch preparation', async (t) => {
  let preparing = false;
  let finishModel;
  const modelReady = new Promise((resolve) => { finishModel = resolve; });
  const h = harness(t, await storage(t), { request: async (method) => {
    if (method === 'model/list') { preparing = true; await modelReady; return { data: [model], nextCursor: null }; }
  } });
  const tick = h.tick();
  await until(() => preparing);
  await h.controller.primeNow();
  assert.equal(h.requests.filter(({ method }) => method === 'model/list').length, 1);
  finishModel();
  await tick;
  assert.equal(h.sends.length, 1);
  assert.ok(h.vscode.messages.some(({ type, message }) => type === 'warning' && /already checking/.test(message)));
});

test('host confirmation carries handled and next boundaries into a different cached Memento', async (t) => {
  const directory = await storage(t);
  const boundary = NOW - 120_000;
  await writeQuotaPrimerSendJournal(directory, { version: 1, updatedAtMs: NOW,
    threadId: 'primer-thread', pending: { threadId: 'primer-thread', turnId: completed.id, sentAtMs: NOW - 60_000,
      primaryResetAtMs: boundary, primaryProbeObservedAtMs: NOW - 60_000, primaryProbeResetAtMs: NOW + DURATION } });
  const h = harness(t, directory, { quota: quota(true, 1), request(method) {
    if (method === 'thread/turns/list') return { data: [completed], nextCursor: null };
  } });
  await h.tick();
  const journal = (await readQuotaPrimerSendJournal(directory)).journal;
  assert.equal(journal.pending, undefined);
  assert.equal(journal.handledPrimaryResetAtMs, boundary);
  assert.equal(journal.nextPrimaryResetAtMs, NOW + DURATION);
  const other = harness(t, directory, { quota: quota(true, 1) });
  await other.tick();
  assert.equal(other.context.globalState.get(STATE).primary.trackedResetAtMs, NOW + DURATION);
  assert.equal(other.sends.length, 0);
});
