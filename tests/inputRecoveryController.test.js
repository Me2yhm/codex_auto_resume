const assert = require('node:assert/strict');
const test = require('node:test');
const { createControllerHarness } = require('./helpers/controllerHarness');
const KEY = 'codexAutoResume.armed';
const NOW = 1_900_000_000_000;
const THREAD = 'input-aware-work';
const quota = (available = true) => ({ ordinaryUsageAllowed: available, rateLimits: {
  primary: { usedPercent: available ? 5 : 100, windowDurationMins: 300, resetsAt: (NOW + 3600000) / 1000 },
  secondary: null, rateLimitReachedType: available ? null : 'workspace_member_credits_depleted',
} });
const user = (id, text = 'Full original prompt\nOffline only. CTP requires separate authorization.') => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] });
const turn = (id = 'failed-input', progress = false) => ({ id, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' },
  startedAt: NOW / 1000, completedAt: NOW / 1000, itemsView: 'full', items: [user(`message-${id}`), ...(progress ? [{ type: 'commandExecution', id: `progress-${id}`, status: 'completed' }] : [])] });

function setup(t, options = {}) {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  let turns = options.turns ?? [turn()];
  let rates = quota(options.available !== false);
  let failHistory = false;
  const sent = [];
  const previews = [];
  const h = createControllerHarness({
    workspaceState: options.workspaceState,
    workspaceValues: { [KEY]: { threadId: THREAD, cwd: '/workspace', armedAtMs: NOW - 60000,
      resetAtMs: NOW + 3600000, reason: 'usageLimitExceeded', interruptedTurnId: turns[0].id, ...options.armed } },
    configuration: { 'codexAutoResume.inputRecovery.enabled': true,
      'codexAutoResume.inputRecovery.userOnlyPolicy': options.policy ?? 'review',
      'codexAutoResume.resumePrompt': 'CONTINUE_EXISTING_WORK',
    },
    mocks: { './officialCodexUi': { async sendTurnThroughOfficialCodexUi(threadId, prompt, output, prefix, overrides, guard) {
      await options.onDiscovery?.(h);
      await guard?.();
      sent.push({ threadId, prompt, prefix });
      if (options.ambiguous) throw new Error('acknowledgement lost');
      return options.sent !== false;
    } } },
    request(method, params) {
      if (method === 'account/rateLimits/read') {
        if (rates instanceof Error) throw rates;
        return rates;
      }
      if (method === 'thread/turns/list') {
        if (params.itemsView === 'full' && failHistory) throw new Error('full history unavailable');
        return { data: turns, nextCursor: null };
      }
      if (method === 'thread/list') return { data: [{ id: THREAD, cwd: '/workspace', updatedAt: now / 1000, source: 'vscode', status: { type: 'inactive' } }], nextCursor: null };
      throw new Error(method);
    },
  });
  h.vscode.workspace.openTextDocument = async doc => { previews.push(doc); return doc; };
  h.vscode.window.showTextDocument = async () => {};
  h.controller.waitForNewTurn = async () => undefined;
  h.controller.observeTrackedResumeAttempt = async () => {};
  t.after(h.dispose);
  return Object.assign(h, {
    sent, previews,
    state: () => h.context.workspaceState.get(KEY),
    advance(ms = 10000) { now += ms; },
    setTurns(value) { turns = value; },
    setQuota(value) { rates = value; },
    failHistory(value = true) { failHistory = value; },
    choose(callback) { h.vscode.window.showWarningMessage = async (message, options, ...choices) => choices.length ? callback(choices, h) : undefined; },
  });
}

test('default user-only behavior saves exact input and never substitutes a generic continuation', async t => {
  const h = setup(t);
  await h.tick(); h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.state().recoveryPlan.inputs[0].content[0].text, user('m').content[0].text);
  await h.controller.showStatus();
  assert.ok(h.vscode.messages.some(x => x.message.includes('needs review')));
});

test('progressed quota failure keeps the default continuation and two-read confirmation', async t => {
  const h = setup(t, { turns: [turn('work', true)] });
  await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].prompt, 'CONTINUE_EXISTING_WORK');
  assert.equal(h.sent[0].threadId, THREAD);
});

test('opt-in user-only replay preserves exact whitespace, question and answer on the original thread', async t => {
  const source = turn(); source.items[0].content[0].text = '  Question: authorize simulation?\n\nOffline only; authorize CTP separately.  ';
  const h = setup(t, { turns: [source], policy: 'replayStableUserOnly' });
  await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  h.advance(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].prompt, source.items[0].content[0].text);
  assert.equal(h.state().replayAttempts, 1);
});

test('late quota-rejected answer updates an already Armed task before quota reset', async t => {
  const old = turn('old-task', true);
  const h = setup(t, { turns: [old], available: false });
  await h.tick();
  const answer = turn('new-answer'); answer.items[0].content[0].text = 'Do not connect; offline only.';
  h.setTurns([answer, old]); h.advance(); await h.tick();
  assert.equal(h.state().interruptedTurnId, answer.id);
  assert.equal(h.state().recoveryPlan.inputs[0].content[0].text, 'Do not connect; offline only.');
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.sent.length, 0);
});

test('explicit review queues a replay but cannot bypass blocked quota', async t => {
  const h = setup(t, { available: false });
  await h.tick();
  h.choose(choices => choices[0]);
  await h.controller.reviewRecoveryInput();
  assert.equal(h.state().recoveryPlan.action, 'replay_input');
  assert.equal(h.sent.length, 0);
  h.advance(); await h.tick(); assert.equal(h.sent.length, 0);
  h.setQuota(quota()); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].prompt, user('m').content[0].text);
});

test('an edited input while the review dialog is open invalidates the stale choice', async t => {
  const h = setup(t);
  await h.tick();
  h.choose(choices => { const changed = turn(); changed.items[0].content[0].text = 'REVISED'; h.setTurns([changed]); return choices[0]; });
  await h.controller.reviewRecoveryInput();
  assert.equal(h.state().recoveryPlan.approval, undefined);
  assert.equal(h.sent.length, 0);
});

test('source changed during owner discovery cancels known-unsent replay instead of sending old input', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly', onDiscovery() {
    const changed = turn('new-answer'); changed.items[0].content[0].text = 'Cancel prior task'; h.setTurns([changed]);
  } });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().dispatchPending, undefined);
  assert.equal(h.state().replayAttempts, undefined);
});

test('Disable during owner discovery cancels an input replay', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly', onDiscovery: current => current.controller.disable() });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state(), undefined);
});

test('full-history failure retains saved input and blocks even an approved replay', async t => {
  const h = setup(t);
  await h.tick(); h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  h.failHistory(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.stale, true);
  assert.equal(h.state().recoveryPlan.inputs.length, 1);
});

test('ambiguous delivery keeps the dispatch fence and does not replay again', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly', ambiguous: true });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.ok(h.state().dispatchPending);
  h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 1);
});

test('replayed input that later performs work and exhausts quota is reclassified as continue', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly' });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  const attempted = { ...h.state(), resumeTurnId: 'executed-replay', dispatchPending: undefined };
  await h.context.workspaceState.update(KEY, attempted);
  h.setTurns([turn('executed-replay', true)]);
  h.setQuota(quota(false)); h.advance(); await h.tick();
  assert.equal(h.state().interruptedTurnId, 'executed-replay');
  h.advance(); await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'continue');
  assert.equal(h.state().replayAttempts, 0);
  h.setQuota(quota()); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent[1].prompt, 'CONTINUE_EXISTING_WORK');
});

test('multiple rejected inputs remain held and all are preserved', async t => {
  const h = setup(t, { turns: [turn('constraints'), turn('original')], policy: 'replayStableUserOnly' });
  await h.tick(); h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.reason, 'multiple_unresolved_inputs');
  assert.equal(h.state().recoveryPlan.inputs.length, 2);
});

test('native/user continuation already running is followed without replaying prior input', async t => {
  const work = { ...turn('manual', true), status: 'inProgress', error: null };
  const h = setup(t, { turns: [work], armed: { interruptedTurnId: 'old' } });
  await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().resumeTurnId, 'manual');
});

test('inProgress lifecycle without recorded progress cannot disarm an input-aware attempt', async t => {
  const source = { ...turn('allocated'), status: 'inProgress', error: null };
  const h = setup(t, { turns: [source], armed: { resumeTurnId: source.id, resumeInProgressSinceMs: NOW - 60000 } });
  await h.tick(); h.advance(60000); await h.tick();
  assert.ok(h.state());
  assert.equal(h.state().resumeInProgressSinceMs, undefined);
  assert.equal(h.sent.length, 0);
});

test('completion while a newer user input has quota-failed retains the exact conversation', async t => {
  const old = { ...turn('completed-work', true), status: 'completed', error: null };
  const next = turn('late-answer');
  const h = setup(t, { turns: [next, old], armed: { resumeTurnId: old.id } });
  await h.tick();
  assert.equal(h.state().interruptedTurnId, next.id);
  assert.equal(h.state().recoveryPlan.candidate, 'replay_input');
  assert.equal(h.sent.length, 0);
});

test('read-only evidence report excludes raw input and invokes no sender', async t => {
  const source = turn(); source.items[0].content[0].text = 'secret=NEVER_PRINT';
  const h = setup(t, { turns: [source] });
  await h.controller.inspectRecoveryInput();
  assert.equal(h.sent.length, 0);
  assert.equal(h.previews[0].content.includes('NEVER_PRINT'), false);
  assert.equal(h.logs.join('\n').includes('NEVER_PRINT'), false);
});

test('manual Resume Now does not replace unresolved input with a generic prompt', async t => {
  const h = setup(t);
  await h.tick(); await h.controller.resumeNow();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
});

test('accepted replay lineage is attached only to an observed matching input', async t => {
  const original = turn('original');
  const h = setup(t, { turns: [original], policy: 'replayStableUserOnly' });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  const retry = turn('retry', true);
  h.setTurns([retry, original]);
  await h.controller.trackResumeTurn(h.state(), retry);
  assert.equal(h.state().replaySourceTurnId, 'original');
  assert.equal(h.state().replayTurnId, 'retry');
  h.advance(); await h.tick(); // explicit failure rearms the retried turn
  h.advance(); await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'continue');
});

test('a different newer user message is never assigned the automatic replay lineage', async t => {
  const original = turn('original');
  const h = setup(t, { turns: [original], policy: 'replayStableUserOnly' });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  const reply = turn('reply'); reply.items[0].content[0].text = 'New user instruction, not the replay';
  h.setTurns([reply, original]);
  await h.controller.trackResumeTurn(h.state(), reply);
  assert.equal(h.state().replaySourceTurnId, undefined);
  h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.state().recoveryPlan.inputs.length, 2);
});

test('reload preserves an approved input and sends only after fresh quota confirmation', async t => {
  const old = setup(t, { available: false });
  await old.tick(); old.choose(choices => choices[0]); await old.controller.reviewRecoveryInput();
  const saved = JSON.parse(JSON.stringify(old.state()));
  old.dispose();
  const next = setup(t, { armed: saved });
  await next.tick(); assert.equal(next.sent.length, 0);
  next.advance(); await next.tick();
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].prompt, user('m').content[0].text);
});

test('reload preserves an ambiguous dispatch and cannot replay its saved input again', async t => {
  const old = setup(t, { policy: 'replayStableUserOnly', ambiguous: true });
  await old.tick(); old.advance(); await old.tick(); old.advance(); await old.tick();
  const saved = JSON.parse(JSON.stringify(old.state()));
  old.dispose();
  const next = setup(t, { armed: saved });
  await next.tick(); next.advance(60000); await next.tick();
  assert.equal(next.sent.length, 0);
  assert.ok(next.state().dispatchPending);
});

test('automatic replay attempt cap survives restoration of Armed state', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly', armed: { replayAttempts: 2 } });
  await h.tick(); h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.reason, 'automatic_replay_limit');
});

test('manual Stop on a newer turn never authorizes a replay or a generic continuation', async t => {
  const h = setup(t, { turns: [{ ...turn('manual-stop'), status: 'interrupted', error: null }], armed: { interruptedTurnId: 'previous' } });
  await h.tick(); h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.reason, 'latest_turn_not_quota_failed');
});

test('quota read failure during confirmation cancels a queued approved replay', async t => {
  const h = setup(t);
  await h.tick(); h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  await h.tick(); h.advance(); h.setQuota(new Error('offline')); await h.tick();
  assert.equal(h.sent.length, 0);
  h.setQuota(quota()); h.advance(); await h.tick(); assert.equal(h.sent.length, 0);
  h.advance(); await h.tick(); assert.equal(h.sent.length, 1);
});

test('full read fails during owner preflight: release only the definitely unsent claim', async t => {
  const h = setup(t, { policy: 'replayStableUserOnly', onDiscovery() { h.failHistory(); } });
  await h.tick(); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().dispatchPending, undefined);
  assert.equal(h.state().replayAttempts, undefined);
});

test('completed resumed work can still disarm normally in input-aware mode', async t => {
  const done = { ...turn('done', true), status: 'completed', error: null };
  const h = setup(t, { turns: [done], armed: { resumeTurnId: done.id } });
  await h.tick();
  assert.equal(h.state(), undefined);
  assert.equal(h.sent.length, 0);
});

test('structured original input is not flattened by the user-review command', async t => {
  const source = turn(); source.items[0].content.push({ type: 'localImage', path: '/tmp/private.png' });
  const h = setup(t, { turns: [source], policy: 'replayStableUserOnly' });
  await h.tick(); h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  h.advance(60000); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().recoveryPlan.inputs[0].content.length, 2);
  assert.equal(h.state().recoveryPlan.reason, 'unsupported_structured_input');
});

test('same-turn new steering input is not confirmed by execution from before that input', async t => {
  const steered = { ...turn('steered', true), status: 'inProgress', error: null };
  steered.items.push(user('new-steering-input', 'New constraint'));
  const h = setup(t, { turns: [steered], armed: { resumeTurnId: steered.id, resumeInProgressSinceMs: NOW - 60000 } });
  await h.tick();
  assert.ok(h.state());
  assert.equal(h.state().resumeInProgressSinceMs, undefined);
  assert.equal(h.sent.length, 0);
});


test('a newer quota-rejected answer supersedes an older interrupted-null verification', async t => {
  const old = { ...turn('old-attempt', true), status: 'interrupted', error: null };
  const answer = turn('new-answer'); answer.items[0].content[0].text = 'Offline only, not additional authorization.';
  const h = setup(t, { turns: [answer, old], armed: { resumeTurnId: old.id, interruptedTurnId: 'earlier' }, available: false });
  await h.tick();
  assert.equal(h.state().resumeTurnId, undefined);
  assert.equal(h.state().interruptedTurnId, answer.id);
  assert.equal(h.state().recoveryPlan.inputs[0].content[0].text, answer.items[0].content[0].text);
  assert.equal(h.sent.length, 0);
});

test('disabling the input-aware setting cannot bypass an already saved review', async t => {
  const h = setup(t);
  await h.tick();
  h.vscode.configuration['codexAutoResume.inputRecovery.enabled'] = false;
  h.advance(60000); await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.sent.length, 0);
});


test('the real TXT-backed prompt is snapshotted and expanded after an explicit review', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-ui-'));
  const dir = path.join(home, 'attachments', '0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'Pasted text.txt');
  const plan = '调研计划\n只读，严禁运行生产交易\n'.repeat(100);
  await fs.writeFile(file, plan);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const original = '# Files pasted by the user:\n\n## "Optimizer 调研计划": ' +
    file + '\n\n## My request:\n先只读调研，不连接实盘。\n';
  const failed = turn(); failed.items[0].content[0].text = original;
  const h = setup(t, { turns: [failed], available: false });
  await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.state().recoveryPlan.attachmentIntegrity.status, 'verified');
  assert.equal(h.state().recoveryPlan.pastedTxtSnapshots[0].text, plan);
  await h.controller.inspectRecoveryInput();
  assert.equal(h.previews[0].content.includes(plan), false);
  assert.equal(h.previews[0].content.includes(file), false);
  h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  assert.equal(h.state().recoveryPlan.action, 'replay_input');
  assert.equal(h.sent.length, 0);
  h.setQuota(quota()); h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].threadId, THREAD);
  assert.ok(h.sent[0].prompt.startsWith(original));
  assert.ok(h.sent[0].prompt.includes(plan));
  assert.ok(h.sent[0].prompt.includes('sha256='));
  assert.equal(h.state().replayAttempts, 1);
});

test('TXT modification during official owner discovery cancels a definitely-unsent replay', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-discovery-'));
  const dir = path.join(home, 'attachments', '0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'Pasted text.txt');
  await fs.writeFile(file, 'PINNED REQUIREMENTS');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const original = '# Files pasted by the user:\n\n## "plan": ' +
    file + '\n\n## My request:\nOffline only\n';
  const failed = turn(); failed.items[0].content[0].text = original;
  const h = setup(t, { turns: [failed], onDiscovery: async () => {
    await fs.writeFile(file, 'CHANGED, UNAPPROVED PLAN');
  } });
  await h.tick();
  h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  h.advance(); await h.tick(); h.advance(); await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.state().dispatchPending, undefined);
  assert.equal(h.state().replayAttempts, undefined);
  h.advance(); await h.tick();
  assert.equal(h.state().recoveryPlan.action, 'needs_review');
  assert.equal(h.state().recoveryPlan.reason, 'attachment_modified');
});

test('reloading with a pinned TXT snapshot refuses a missing original, without sending the naked path', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-reload-'));
  const dir = path.join(home, 'attachments', '0a3f824f-592f-4ac1-ba7b-b5d6fd8aadd3');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'Pasted text.txt');
  await fs.writeFile(file, 'PINNED PLAN');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const failed = turn(); failed.items[0].content[0].text =
    '# Files pasted by the user:\n\n## "plan": ' + file + '\n\n## My request:\nOffline only\n';
  const h = setup(t, { turns: [failed], available: false });
  await h.tick(); h.choose(choices => choices[0]); await h.controller.reviewRecoveryInput();
  const saved = JSON.parse(JSON.stringify(h.state()));
  h.dispose();
  await fs.unlink(file);
  const next = setup(t, { turns: [failed], armed: saved });
  await next.tick();
  assert.equal(next.state().recoveryPlan.action, 'needs_review');
  assert.equal(next.state().recoveryPlan.reason, 'attachment_missing');
  next.setQuota(quota()); next.advance(); await next.tick(); next.advance(); await next.tick();
  assert.equal(next.sent.length, 0);
});
