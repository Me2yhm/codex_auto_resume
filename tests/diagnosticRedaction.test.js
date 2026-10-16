const assert = require('node:assert/strict');
const test = require('node:test');
const { redactDiagnostic, redactedOutputChannel } = require('../dist/diagnosticRedaction');

test('upstream diagnostics redact proxy URLs and credential assignments without losing state evidence', () => {
  const message = 'quota unavailable; proxy=https://user:password@proxy.example:8443/path?token=secret; OPENAI_API_KEY=sk-test-secret accessToken="session-secret" Authorization: Bearer bearer-secret';
  const redacted = redactDiagnostic(message);
  for (const secret of ['user:password', 'proxy.example', 'sk-test-secret', 'session-secret', 'bearer-secret']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /quota unavailable/);
  assert.match(redacted, /redacted/);
  assert.equal(redactDiagnostic('confirmed early resume; thread=work-1; turn=turn-2'), 'confirmed early resume; thread=work-1; turn=turn-2');
});

test('all output-channel text entry points redact and lifecycle methods retain the original receiver', () => {
  const calls = [];
  const original = {
    name: 'Codex Auto Resume',
    append(value) { assert.equal(this, original); calls.push(value); },
    appendLine(value) { assert.equal(this, original); calls.push(value); },
    replace(value) { assert.equal(this, original); calls.push(value); },
    show() { assert.equal(this, original); calls.push('show'); },
    dispose() { assert.equal(this, original); calls.push('dispose'); },
  };
  const output = redactedOutputChannel(original);
  for (const method of ['append', 'appendLine', 'replace']) output[method]('HTTP_PROXY=http://private-proxy:1234');
  output.show(); output.dispose();
  assert.equal(output.name, original.name);
  assert.deepEqual(calls, ['HTTP_PROXY=[redacted URL]', 'HTTP_PROXY=[redacted URL]', 'HTTP_PROXY=[redacted URL]', 'show', 'dispose']);
});

test('Primer transport failure also redacts warnings and status messages', async (t) => {
  const path = require('node:path');
  const { createControllerHarness } = require('./helpers/controllerHarness');
  const h = createControllerHarness({
    modulePath: path.resolve(__dirname, '../dist/quotaPrimerController.js'), exportName: 'QuotaPrimerController',
    configuration: { 'codexAutoResume.quotaPrimer.enabled': true },
    request() { throw new Error('HTTP timeout at https://user:secret@private-proxy:8080 OPENAI_API_KEY=sk-private'); },
  });
  t.after(h.dispose);
  await h.controller.primeNow();
  await h.controller.showStatus();
  const visible = h.vscode.messages.map(message => message.message).join('\n') + h.logs.join('\n');
  for (const secret of ['user:secret', 'private-proxy', 'sk-private']) assert.equal(visible.includes(secret), false);
  assert.match(visible, /quota read unavailable|HTTP timeout/);
});
