const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyRecoveryHistory, replayText, recoveryDiagnostic, MAX_INPUT_BYTES } = require('../dist/inputRecovery');
const { readRecoveryHistory } = require('../dist/recoveryHistory');
const NOW = 1_900_000_000_000;
const input = (text = 'Original input\nCTP requires separate authorization.') => ({ type: 'text', text, text_elements: [] });
const user = (id = 'message', text) => ({ type: 'userMessage', id, content: [input(text)] });
const failed = (id = 'failed', items = [user()]) => ({ id, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, itemsView: 'full', items, startedAt: NOW / 1000, completedAt: NOW / 1000 });
const history = (...turns) => ({ turns, complete: true });
const classify = (h, options = {}) => classifyRecoveryHistory(h, { nowMs: NOW, ...options });

test('full user-only quota failure defaults to review, not proof of non-execution', () => {
  const plan = classify(history(failed()));
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.candidate, 'replay_input');
  assert.equal(replayText(plan), input().text);
});

test('explicit opt-in requires two stable full snapshots before replay', () => {
  const h = history(failed());
  let plan = classify(h, { policy: 'replayStableUserOnly' });
  assert.equal(plan.action, 'needs_review');
  plan = classify(h, { policy: 'replayStableUserOnly', previous: plan, nowMs: NOW + 9999 });
  assert.equal(plan.action, 'needs_review');
  plan = classify(h, { policy: 'replayStableUserOnly', previous: plan, nowMs: NOW + 10000 });
  assert.equal(plan.action, 'replay_input');
});

for (const kind of ['agentMessage', 'reasoning', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']) {
  test(`recorded ${kind} is positive progress evidence, so recovery continues instead of restarting`, () => {
    const plan = classify(history(failed('work', [user(), { type: kind, id: 'progress', text: 'Work', status: 'completed' }])));
    assert.equal(plan.action, 'continue');
  });
}

for (const kind of ['summary', 'notLoaded', null, undefined]) {
  test(`itemsView=${kind} cannot authorize replay or generic continuation`, () => {
    const turn = { ...failed(), itemsView: kind };
    const plan = classify(history(turn), { policy: 'replayStableUserOnly' });
    assert.equal(plan.action, 'needs_review');
    assert.equal(plan.reason, 'items_not_full_or_malformed');
  });
}

test('a late answer is bound to its own turn rather than progress from the preceding task', () => {
  const h = history(failed('answer', [user('answer-message', 'Offline only; simulation needs separate approval.')]),
    failed('old-task', [user('task'), { type: 'commandExecution', id: 'command' }]));
  const plan = classify(h);
  assert.equal(plan.candidate, 'replay_input');
  assert.deepEqual(plan.inputs.map(x => x.turnId), ['answer']);
});

test('multiple consecutive rejected messages are preserved oldest-first, never reduced to the last', () => {
  const plan = classify(history(failed('constraint', [user('m2', 'No live access')]), failed('task', [user('m1', 'Full task body')])));
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
  assert.deepEqual(plan.inputs.map(x => x.messageId), ['m1', 'm2']);
});

test('same-turn steering and multiple user messages remain ambiguous', () => {
  for (const items of [[{ type: 'commandExecution', id: 'old' }, user()], [user('old'), { type: 'reasoning', id: 'r' }, user('new')]]) {
    assert.equal(classify(history(failed('steer', items))).action, 'needs_review');
  }
});

for (const item of [{ type: 'hookPrompt' }, { type: 'contextCompaction' }, { type: 'futureItem' }, null]) {
  test(`unknown/context item ${JSON.stringify(item)} does not prove a safe replay`, () => {
    assert.equal(classify(history(failed('x', [user(), item]))).action, 'needs_review');
  });
}

test('unanswered question and live permission request do not become implicit approval', () => {
  const items = [
    { type: 'agentMessage', id: 'q', text: 'Proceed?', questions: [{ id: 'question' }] },
    { type: 'dynamicToolCall', id: 'q', tool: 'request_user_input', status: 'inProgress' },
  ];
  for (const q of items) assert.equal(classify(history(failed('question', [user(), q]))).reason, 'unanswered_question_or_approval');
});

for (const content of [
  [{ type: 'image', url: 'https://example.invalid/image.png' }],
  [{ type: 'skill', name: 'skill', path: '/skill' }],
  [{ type: 'text', text: 'input', text_elements: [{ start: 0, end: 2 }] }],
  [{ type: 'text', text: 'input' }],
  [{ type: 'text', text: 'input', text_elements: [], futureMetadata: 'not flattenable' }],
  [input('first'), input('second')],
]) {
  test(`unsupported structured payload ${content[0].type} is retained without flattening`, () => {
    const plan = classify(history(failed('x', [{ type: 'userMessage', id: 'm', content }])));
    assert.equal(plan.reason, 'unsupported_structured_input');
    assert.deepEqual(plan.inputs[0].content, content);
    assert.equal(replayText(plan), undefined);
  });
}

test('source edit invalidates both stability and a per-source manual approval', () => {
  const h = history(failed());
  let plan = classify(h);
  plan.approval = { action: 'replay_input', fingerprint: plan.fingerprint };
  assert.equal(classify(h, { previous: plan }).action, 'replay_input');
  const updated = classify(history(failed('failed', [user('message', 'Changed decision')])), { previous: plan, nowMs: NOW + 20000 });
  assert.equal(updated.action, 'needs_review');
  assert.equal(updated.approval, undefined);
  assert.equal(updated.stableSinceMs, NOW + 20000);
});

test('incomplete history keeps saved input but revokes sending until a fresh full observation', () => {
  const first = classify(history(failed()));
  first.approval = { action: 'replay_input', fingerprint: first.fingerprint };
  const unknown = classify({ turns: [], complete: false, reason: 'full_history_unavailable' }, { previous: first });
  assert.equal(unknown.action, 'needs_review');
  assert.equal(unknown.stale, true);
  assert.deepEqual(unknown.inputs, first.inputs);
  assert.equal(unknown.approval, undefined);
});

test('automatic replay budget is bounded but an explicit new decision can permit one attempt', () => {
  const h = history(failed());
  let p = classify(h, { policy: 'replayStableUserOnly', replayAttempts: 2 });
  p = classify(h, { previous: p, policy: 'replayStableUserOnly', replayAttempts: 2, nowMs: NOW + 60000 });
  assert.equal(p.reason, 'automatic_replay_limit');
  p.approval = { action: 'replay_input', fingerprint: p.fingerprint };
  assert.equal(classify(h, { previous: p, replayAttempts: 2 }).action, 'replay_input');
});

test('replayed input that later did real work changes from replay to continue', () => {
  const first = classify(history(failed()));
  const executed = classify(history(failed('retry', [user('retry-input'), { type: 'fileChange', id: 'edit' }])), { previous: first, replayAttempts: 2 });
  assert.equal(executed.action, 'continue');
});

test('input size bound is explicit and never reports a truncated prompt as saved', () => {
  const plan = classify(history(failed('big', [user('huge', 'a'.repeat(MAX_INPUT_BYTES + 1))])));
  assert.equal(plan.reason, 'input_too_large');
  assert.equal(plan.inputs.length, 0);
});

test('diagnostics contain structure but not prompt, tool text, or credentials', () => {
  const plan = classify(history(failed('secret', [user('m', 'password=DO_NOT_LOG'), { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'DO_NOT_LOG' }])));
  const diagnostic = JSON.stringify(recoveryDiagnostic(plan));
  assert.equal(diagnostic.includes('DO_NOT_LOG'), false);
  assert.ok(diagnostic.includes('commandExecution'));
});

test('full reader is strictly read-only, paginates and stops at a prior execution boundary', async () => {
  const requests = [];
  const client = { async request(method, params) {
    requests.push({ method, params });
    return params.cursor ? { data: [failed('old', [user('old-input'), { type: 'reasoning', id: 'r' }])], nextCursor: 'not-needed' }
      : { data: [failed('new')], nextCursor: 'older' };
  } };
  const result = await readRecoveryHistory(client, 'thread');
  assert.equal(result.complete, true);
  assert.equal(result.turns.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.method === 'thread/turns/list' && r.params.itemsView === 'full' && r.params.threadId === 'thread'));
});

for (const fixture of ['exception', 'malformed', 'summary', 'duplicate', 'cycle']) {
  test(`full reader fails closed for ${fixture}`, async () => {
    let calls = 0;
    const client = { async request() {
      calls++;
      if (fixture === 'exception') throw new Error('not supported');
      if (fixture === 'malformed') return { data: null };
      if (fixture === 'summary') return { data: [{ ...failed(), itemsView: 'summary' }], nextCursor: null };
      if (fixture === 'duplicate') return { data: [failed(), failed()], nextCursor: null };
      return { data: [failed(`id-${calls}`)], nextCursor: 'same' };
    } };
    const result = await readRecoveryHistory(client, 'thread');
    assert.equal(result.complete, false);
  });
}

test('later progress does not silently discard a preceding independently rejected input', () => {
  const h = history(failed('later', [user('later-message', 'Additional requirement'), { type: 'reasoning', id: 'r' }]),
    failed('earlier', [user('earlier-message', 'Original task')]));
  const plan = classify(h);
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
  assert.deepEqual(plan.inputs.map(x => x.messageId), ['earlier-message', 'later-message']);
});

test('known own-replay lineage prevents counting the original rejected input twice', () => {
  const h = history(failed('retry', [user('retry-message'), { type: 'commandExecution', id: 'cmd' }]), failed('original'));
  const plan = classify(h, { replaySourceTurnId: 'original' });
  assert.equal(plan.action, 'continue');
  assert.equal(plan.inputs.length, 1);
});
