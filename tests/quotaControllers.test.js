const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createControllerHarness } = require('./helpers/controllerHarness');

const snapshot = (ordinaryUsageAllowed, usedPercent = 1, rateLimitReachedType = null) => ({
  ordinaryUsageAllowed,
  rateLimits: {
    primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_900_000_000 },
    secondary: null,
    rateLimitReachedType,
  },
});

test('Auto Resume and Primer share quota permission semantics including the legacy endpoint fallback', async () => {
  for (const response of [snapshot(true), snapshot(false), snapshot(null), snapshot(undefined), snapshot(true, 100), snapshot(undefined, 99), { rateLimits: {} }]) {
    for (const primer of [false, true]) {
      let calls = 0;
      const h = createControllerHarness({
        ...(primer ? { modulePath: path.resolve(__dirname, '../dist/quotaPrimerController.js'), exportName: 'QuotaPrimerController' } : {}),
        request(method, params) {
          assert.equal(method, 'account/rateLimits/read');
          if (++calls === 1) {
            assert.equal(params.excludeResetCreditDetails, true);
            throw new Error('invalid params: unknown field excludeResetCreditDetails');
          }
          return response;
        },
      });
      try {
        await h.controller.ensureClient();
        const limits = await h.controller.readRateLimits();
        const expected = Boolean(response.ordinaryUsageAllowed !== false && response.ordinaryUsageAllowed !== null && response.rateLimits.primary?.usedPercent < 99);
        assert.equal(h.controller.quotaLooksAvailable(limits), expected, JSON.stringify({ primer, response }));
        assert.equal(calls, 2);
      } finally { h.dispose(); }
    }
  }
});

test('manual Primer warns and sends nothing for timeout, ordinaryUsageAllowed=false, and conflicting quota', async () => {
  for (const response of [undefined, snapshot(false), snapshot(true, 100), { rateLimits: null }]) {
    const h = createControllerHarness({
      modulePath: path.resolve(__dirname, '../dist/quotaPrimerController.js'), exportName: 'QuotaPrimerController',
      request() { if (response === undefined) throw new Error('HTTP timeout'); return response; },
    });
    try {
      await h.controller.primeNow();
      assert.equal(h.sends.length, 0);
      assert.equal(h.requests.some(r => /thread\/start|turn\/start/.test(r.method)), false);
      assert.ok(h.vscode.messages.some(m => m.type === 'warning'));
    } finally { h.dispose(); }
  }
});
