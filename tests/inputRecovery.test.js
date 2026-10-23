const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyRecoveryHistory, replayText, recoveryDiagnostic, MAX_INPUT_BYTES,
  hasUnambiguousInputProgress } = require('../dist/inputRecovery');
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
    const plan = classify(history(failed('work', [user(), { type: kind, id: 'progress', text: 'Work', summary: ['Work'], content: [], status: 'completed' }])));
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
    failed('old-task', [user('task'), { type: 'commandExecution', id: 'command', status: 'completed' }]));
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
  for (const items of [[{ type: 'commandExecution', id: 'old' }, user()], [user('old'), { type: 'reasoning', id: 'r', summary: ['Existing work'], content: [] }, user('new')]]) {
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
  const executed = classify(history(failed('retry', [user('retry-input'), { type: 'fileChange', id: 'edit', status: 'completed' }])), { previous: first, replayAttempts: 2 });
  assert.equal(executed.action, 'continue');
});

test('input size bound is explicit and never reports a truncated prompt as saved', () => {
  const plan = classify(history(failed('big', [user('huge', 'a'.repeat(MAX_INPUT_BYTES + 1))])));
  assert.equal(plan.reason, 'input_too_large');
  assert.equal(plan.inputs.length, 0);
});

test('diagnostics contain structure but not prompt, tool text, or credentials', () => {
  const plan = classify(history(failed('secret', [user('m', 'password=DO_NOT_LOG'), { type: 'commandExecution', id: 'cmd', status: 'completed', aggregatedOutput: 'DO_NOT_LOG' }])));
  const diagnostic = JSON.stringify(recoveryDiagnostic(plan));
  assert.equal(diagnostic.includes('DO_NOT_LOG'), false);
  assert.ok(diagnostic.includes('commandExecution'));
});

test('full reader is strictly read-only, paginates and stops at a prior execution boundary', async () => {
  const requests = [];
  const client = { async request(method, params) {
    requests.push({ method, params });
    return params.cursor ? { data: [failed('old', [user('old-input'), { type: 'reasoning', id: 'r', summary: ['Existing work'], content: [] }])], nextCursor: 'not-needed' }
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
  const h = history(failed('later', [user('later-message', 'Additional requirement'), { type: 'reasoning', id: 'r', summary: ['Existing work'], content: [] }]),
    failed('earlier', [user('earlier-message', 'Original task')]));
  const plan = classify(h);
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
  assert.deepEqual(plan.inputs.map(x => x.messageId), ['earlier-message', 'later-message']);
});

test('known own-replay lineage prevents counting the original rejected input twice', () => {
  const h = history(failed('retry', [user('retry-message'), { type: 'commandExecution', id: 'cmd', status: 'completed' }]), failed('original'));
  const plan = classify(h, { replaySourceTurnId: 'original' });
  assert.equal(plan.action, 'continue');
  assert.equal(plan.inputs.length, 1);
});

for (const placeholder of [
  { type: 'agentMessage', id: 'stub', text: '' },
  { type: 'reasoning', id: 'stub', summary: [], content: [] },
  { type: 'plan', id: 'stub', text: '' },
  { type: 'commandExecution', id: 'stub' },
]) {
  test(`empty ${placeholder.type} placeholder cannot authorize replay or generic continuation`, () => {
    const h = history(failed('stubbed', [user(), placeholder]));
    let plan = classify(h, { policy: 'replayStableUserOnly' });
    plan = classify(h, { previous: plan, nowMs: NOW + 60000, policy: 'replayStableUserOnly' });
    assert.equal(plan.action, 'needs_review');
    assert.equal(plan.reason, 'incomplete_activity_evidence');
  });
}


function structuredAnswer(id = 'call_example', answer = '/tmp/synthetic-evidence.zip') {
  const token = 'send_user_' + 'message_question_reply';
  const payload = [{ questionItemId: JSON.stringify(['request_user_input_async', id, 0]),
    question: 'Where is the evidence archive?', answer }];
  return user('answered-question', '<' + token + '>\n' + JSON.stringify(payload) +
    '\n</' + token + '>\n');
}
function answeredTurn(overrides = {}) {
  const items = [
    user('original-request', 'Please verify the plan without production changes.'),
    { type: 'agentMessage', id: 'question', text: 'Where is the evidence?',
      questions: [{ id: 'Q-001' }], status: 'completed' },
    { type: 'dynamicToolCall', id: 'call_example', tool: 'request_user_input_async', status: 'completed' },
    structuredAnswer(),
    { type: 'agentMessage', id: 'ack', text: 'Evidence path received; continuing checks.' },
    { type: 'commandExecution', id: 'subsequent-work', status: 'completed', command: 'verify-fixture' },
  ];
  return failed('answered-quota-failed', overrides.items ?? items);
}

test('realistic original task + resolved Q&A + resumed execution is continue, not another task', () => {
  const h = history(answeredTurn());
  const plan = classify(h);
  assert.equal(plan.action, 'continue');
  assert.equal(plan.candidate, 'continue');
  assert.equal(plan.reason, 'answered_question_followed_by_execution');
  assert.deepEqual(plan.inputs.map(x => x.messageId), ['original-request', 'answered-question']);
  assert.equal(replayText(plan), undefined);
});

test('historic questions and stale inProgress question tool do not block acknowledged reply', () => {
  const t = answeredTurn();
  t.items[2].status = 'inProgress';
  const result = classify(history(t));
  assert.equal(result.action, 'continue');
});

test('unacknowledged answer remains unresolved even if an older command completed', () => {
  const t = answeredTurn();
  t.items.splice(4, 2);
  t.items.push({ type: 'commandExecution', id: 'old-command', status: 'completed' });
  const result = classify(history(t));
  assert.equal(result.action, 'needs_review');
  assert.equal(result.reason, 'multiple_unresolved_inputs');
});

test('unstructured steer after old work is not silently dropped', () => {
  const t = failed('steer', [user('task'), { type: 'agentMessage', id: 'before', text: 'Old work' },
    user('new-user-instruction', 'Cancel the old task and switch projects.'),
    { type: 'agentMessage', id: 'after', text: 'Acknowledged.' }]);
  assert.equal(classify(history(t)).reason, 'multiple_unresolved_inputs');
});

test('a second unanswered question or unrelated pending approval prevents continue', () => {
  const pendingNewQuestion = answeredTurn();
  pendingNewQuestion.items.push({ type: 'agentMessage', id: 'new-q', text: 'Approve another step?',
    questions: [{ id: 'Q-002' }] });
  assert.equal(classify(history(pendingNewQuestion)).action, 'needs_review');
  const pendingPermission = answeredTurn();
  pendingPermission.items[2] = { type: 'dynamicToolCall', id: 'approval',
    tool: 'request_approval', status: 'inProgress' };
  assert.equal(classify(history(pendingPermission)).action, 'needs_review');
});

test('a question reply cannot authorize an unrelated still-pending question', () => {
  const t = answeredTurn();
  t.items[2] = { type: 'dynamicToolCall', id: 'call_unrelated',
    tool: 'request_user_input_async', status: 'inProgress' };
  assert.equal(classify(history(t)).action, 'needs_review');
});

test('separate consecutive rejected turns still retain every independent input', () => {
  const t = answeredTurn();
  const later = failed('later-rejected', [user('fresh-task', 'New requirements without execution')]);
  const plan = classify(history(later, t));
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'user_only_history_requires_review');
  assert.deepEqual(plan.inputs.map(x => x.messageId), ['fresh-task']);
});

test('answer-only user turn with prior question and new agent response also continues', () => {
  const t = failed('reply-only', [
    { type: 'agentMessage', id: 'question', text: 'Where is it?',
      questions: [{ id: 'Q-001' }] },
    structuredAnswer(), { type: 'agentMessage', id: 'confirmation', text: 'Received.' },
  ]);
  const plan = classify(history(t));
  assert.equal(plan.action, 'continue');
});

test('completed in-turn reply also satisfies resumed-turn progress gate', () => {
  const complete = answeredTurn();
  assert.equal(hasUnambiguousInputProgress(complete), true);
  const beforeAcknowledgement = answeredTurn();
  beforeAcknowledgement.items = beforeAcknowledgement.items.slice(0, 4);
  assert.equal(hasUnambiguousInputProgress(beforeAcknowledgement), false);
});

test('one accepted reply cannot resolve two earlier independent questions', () => {
  const t = answeredTurn();
  t.items.splice(2, 0, { type: 'agentMessage', id: 'second-question',
    text: 'Second confirmation?', questions: [{ id: 'Q-002' }] });
  const plan = classify(history(t));
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
});

test('two quota-failed turns with identical input and real work in newest continue rather than replay', () => {
  const initial = failed('quota-first', [user('item-1', 'Run the pinned plan')]);
  const retried = failed('quota-second', [
    user('item-2', 'Run the pinned plan'),
    { type: 'agentMessage', id: 'started', text: 'Reading the plan and checking the workspace' },
    { type: 'commandExecution', id: 'cmd', status: 'completed', command: 'read-only-check' },
    { type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: 'reworked-file' }] },
  ]);
  const h = history(retried, initial);
  const first = classify(history(initial), { policy: 'replayStableUserOnly' });
  const plan = classify(h, { previous: first, policy: 'replayStableUserOnly', replayAttempts: 1 });
  assert.equal(plan.action, 'continue');
  assert.equal(plan.candidate, 'continue');
  assert.equal(plan.reason, 'replayed_input_followed_by_execution');
  assert.equal(plan.sourceTurnId, retried.id);
  assert.deepEqual(plan.inputs.map(x => x.turnId), ['quota-first', 'quota-second']);
  assert.equal(replayText(plan), undefined); // Never resend the plan a third time.
  assert.equal(recoveryDiagnostic(plan).attachmentIntegrity.status, 'not_applicable');
});

test('multiple identical earlier quota-only turns do not become multiple tasks after new execution', () => {
  const h = history(
    failed('attempt-3', [user('third', 'Run plan'), { type: 'commandExecution', id: 'exec', status: 'completed' }]),
    failed('attempt-2', [user('second', 'Run plan')]),
    failed('attempt-1', [user('first', 'Run plan')]),
  );
  const plan = classify(h);
  assert.equal(plan.action, 'continue');
  assert.equal(plan.reason, 'replayed_input_followed_by_execution');
  assert.equal(plan.inputs.length, 3);
});

test('a new independent failed input is never discarded because the later turn executed', () => {
  const h = history(
    failed('later-work', [user('later', 'Additional requirement'), { type: 'commandExecution', id: 'c', status: 'completed' }]),
    failed('first-task', [user('first', 'Run plan')]),
  );
  const plan = classify(h, { policy: 'replayStableUserOnly' });
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
  assert.equal(plan.inputs.length, 2);
});

test('identical quota-only retries without demonstrated execution remain held for Review', () => {
  const plan = classify(history(failed('again', [user('new', 'Run plan')]),
    failed('old', [user('old', 'Run plan')])), { policy: 'replayStableUserOnly' });
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'multiple_unresolved_inputs');
});

test('replayed prompt with additional steering, unknown actions or permission requests is not safe Continue', () => {
  const initial = failed('initial', [user('first', 'Run plan')]);
  for (const suffix of [
    [user('unhandled-steer', 'Now cancel everything')],
    [{ type: 'unsupportedThing', id: 'unknown' }],
    [{ type: 'dynamicToolCall', id: 'approval', tool: 'request_permissions', status: 'inProgress' }],
    [{ type: 'dynamicToolCall', id: 'question-async', tool: 'request_user_input_async', status: 'inProgress' }],
    [{ type: 'agentMessage', id: 'question', text: 'Approve?', questions: [{ id: 'Q' }] }],
  ]) {
    const latest = failed('retry', [
      user('same', 'Run plan'),
      { type: 'commandExecution', id: 'work', status: 'completed' },
      ...suffix,
    ]);
    const result = classify(history(latest, initial));
    assert.equal(result.action, 'needs_review');
    assert.equal(result.reason, 'multiple_unresolved_inputs');
  }
});

test('previous failed turn with executed work is not considered an identical quota-only retry', () => {
  const earlier = failed('earlier', [user('first', 'Run plan'),
    { type: 'commandExecution', id: 'c1', status: 'completed' }]);
  const later = failed('later', [user('new', 'Run plan'),
    { type: 'commandExecution', id: 'c2', status: 'completed' }]);
  // Prior real work is a history boundary, not an extra unsent message.
  // Either way the newest independent progressed turn should continue.
  const p = classify(history(later, earlier));
  assert.equal(p.action, 'continue');
});


test('G4: real work -> context compaction -> more work -> quota failure continues', () => {
  const t = failed('G4-second-quota', [
    user('g4', '授权G4'),
    { type: 'agentMessage', id: 'ack', text: '收到 G4 授权。先检查实际数据。' },
    { type: 'commandExecution', id: 'pre-compact', status: 'completed', command: 'inspect-data' },
    { type: 'reasoning', id: 'thinking', summary: ['Work continues'], content: [] },
    { type: 'contextCompaction', id: 'automatic-context-compaction' },
    { type: 'commandExecution', id: 'post-compact', status: 'completed', command: 'validate-data' },
  ]);
  assert.equal(hasUnambiguousInputProgress(t), true);
  const plan = classify(history(t), { policy: 'replayStableUserOnly' });
  assert.equal(plan.action, 'continue');
  assert.equal(plan.candidate, 'continue');
  assert.equal(plan.reason, 'recorded_execution_after_input');
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.evidence[0].itemTypes.includes('contextCompaction'), true);
  assert.equal(replayText(plan), '授权G4'); // Saved for review, not selected for replay.
});

test('compaction is neutral and is not proof that a quota-rejected input was processed', () => {
  const h = history(failed('only-compaction', [
    user('new-authorization', '授权G4'),
    { type: 'contextCompaction', id: 'metadata-only' },
  ]));
  const first = classify(h, { policy: 'replayStableUserOnly' });
  assert.equal(first.action, 'needs_review');
  assert.equal(first.reason, 'incomplete_activity_evidence');
  const after = classify(h, { policy: 'replayStableUserOnly',
    nowMs: NOW + 60_000, previous: first });
  assert.equal(after.action, 'needs_review');
  assert.equal(after.reason, 'incomplete_activity_evidence');
  assert.equal(hasUnambiguousInputProgress(h.turns[0]), false);
});

test('known compaction never permits a new pending approval or independent steer', () => {
  for (const additional of [
    [{ type: 'dynamicToolCall', id: 'ask', tool: 'request_user_input_async', status: 'inProgress' }],
    [{ type: 'dynamicToolCall', id: 'grant', tool: 'request_permissions', status: 'inProgress' }],
    [user('new-independent-instruction', 'Do a separate production action')],
  ]) {
    const t = failed('compacted-unsafe', [
      user('work', '授权G4'),
      { type: 'commandExecution', id: 'ran', status: 'completed' },
      { type: 'contextCompaction', id: 'compacted' },
      ...additional,
    ]);
    const plan = classify(history(t));
    assert.equal(plan.action, 'needs_review');
    assert.equal(hasUnambiguousInputProgress(t), false);
  }
});

test('compaction does not make any other unknown activity safe to continue', () => {
  const t = failed('unknown-after-compaction', [
    user(), { type: 'commandExecution', id: 'cmd', status: 'completed' },
    { type: 'contextCompaction', id: 'metadata' },
    { type: 'unexpectedFutureEvent', id: 'unknown' },
  ]);
  const plan = classify(history(t));
  assert.equal(plan.action, 'needs_review');
  assert.equal(plan.reason, 'unknown_item_or_context_activity');
  assert.equal(hasUnambiguousInputProgress(t), false);
});

test('compaction before the only user instruction cannot prove that instruction executed', () => {
  const t = failed('compacted-before-g4', [
    { type: 'contextCompaction', id: 'preceding' },
    user('after-compaction', '授权G4'),
    { type: 'commandExecution', id: 'may-be-old', status: 'completed' },
  ]);
  assert.equal(classify(history(t)).reason, 'ambiguous_steering_order');
  assert.equal(hasUnambiguousInputProgress(t), false);
});

test('same input replayed and executed with compaction can continue on later quota failure', () => {
  const first = failed('first-quiet-quota', [user('first', '授权G4')]);
  const second = failed('second-ran-quota', [
    user('replayed', '授权G4'), { type: 'commandExecution', id: 'work', status: 'completed' },
    { type: 'contextCompaction', id: 'compress' },
    { type: 'agentMessage', id: 'after-compress', text: '继续检查缺口。' },
  ]);
  const plan = classify(history(second, first), { policy: 'replayStableUserOnly' });
  assert.equal(plan.action, 'continue');
  assert.equal(plan.reason, 'replayed_input_followed_by_execution');
  assert.equal(plan.inputs.length, 2);
});

test('answered question may cross compaction but still needs a real post-answer acknowledgement', () => {
  const t = answeredTurn();
  t.items.splice(4, 0, { type: 'contextCompaction', id: 'between-answer-and-acknowledgement' });
  assert.equal(classify(history(t)).reason, 'answered_question_followed_by_execution');
  const noAck = answeredTurn();
  noAck.items.splice(4, 1, { type: 'contextCompaction', id: 'only-context' });
  noAck.items.splice(5, 1); // Remove the command that followed the original acknowledgement.
  assert.equal(classify(history(noAck)).action, 'needs_review');
});
