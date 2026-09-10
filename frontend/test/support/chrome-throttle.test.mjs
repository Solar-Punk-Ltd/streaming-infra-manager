/**
 * The throttle that makes this laptop behave like the job's runner.
 *
 * Three browser jobs in a row each failed one different Chrome suite on a
 * two core `ubuntu-latest` while the whole set passed on a twelve core
 * laptop, and each of those failures cost a forty minute cycle to see. A
 * suite cannot be made to hold on a machine it never runs slowly on, so
 * `BROWSER_CPU_THROTTLE` slows every page session the harness opens and the
 * races come here instead.
 *
 * The protocol has no getter for the rate it was given, so the case that
 * proves a real launch applied it times the same arithmetic in the page
 * against itself with the rate lifted.
 */
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { cpuThrottleRate, launchChrome, PROTOCOL_TIMEOUT_MS, protocolTimeoutFor, throttleCpu } from './chrome.mjs';

/** Nothing on this page fetches, so the origin only has to be one no request reaches. */
const MAKES_NO_REQUESTS = 'http://127.0.0.1:1';

/** Enough arithmetic to take tens of milliseconds at full speed, and no allocation to muddle it. */
const BUSY_LOOP = `(() => {
  const started = performance.now();
  let total = 0;
  for (let index = 0; index < 4_000_000; index++) total += Math.sqrt(index);
  return { ms: performance.now() - started, total };
})()`;

const MEASURED_RATE = 8;
/** What a rate of 8 has to show, kept well under 8 so a busy laptop cannot fail the case. */
const LEAST_SLOWDOWN = 3;
const ATTEMPTS = 3;

/** The quickest of several runs, which is the one least disturbed by whatever else the machine is doing. */
async function quickestRun(evaluate) {
  let quickest = Infinity;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    quickest = Math.min(quickest, (await evaluate(BUSY_LOOP)).ms);
  }
  return quickest;
}

describe('the rate the environment asks for', () => {
  it('takes a rate above one', () => {
    assert.equal(cpuThrottleRate({ BROWSER_CPU_THROTTLE: '4' }), 4);
    assert.equal(cpuThrottleRate({ BROWSER_CPU_THROTTLE: '6' }), 6);
    assert.equal(cpuThrottleRate({ BROWSER_CPU_THROTTLE: '2.5' }), 2.5);
  });

  it('reads no throttling from an unset, neutral or impossible value', () => {
    for (const value of [undefined, '', '1', '0', '-4', 'four', 'NaN', 'Infinity']) {
      assert.equal(cpuThrottleRate({ BROWSER_CPU_THROTTLE: value }), null, String(value));
    }
    assert.equal(cpuThrottleRate({}), null);
  });
});

describe('the budget one protocol request gets', () => {
  it('is the plain one when nothing is throttled', () => {
    assert.equal(protocolTimeoutFor({}), PROTOCOL_TIMEOUT_MS);
  });

  it('stretches with the rate, since the evaluate runs in the throttled page', () => {
    assert.equal(protocolTimeoutFor({ BROWSER_CPU_THROTTLE: '4' }), PROTOCOL_TIMEOUT_MS * 4);
    assert.equal(protocolTimeoutFor({ BROWSER_CPU_THROTTLE: '6' }), PROTOCOL_TIMEOUT_MS * 6);
  });
});

describe('what a session is told', () => {
  it('sends the rate the environment names, once', async () => {
    const sent = [];
    const rate = await throttleCpu((method, params) => sent.push({ method, params }), { BROWSER_CPU_THROTTLE: '4' });

    assert.equal(rate, 4);
    assert.deepEqual(sent, [{ method: 'Emulation.setCPUThrottlingRate', params: { rate: 4 } }]);
  });

  it('sends nothing when the environment names no rate', async () => {
    const sent = [];

    assert.equal(await throttleCpu((method) => sent.push(method), {}), null);
    assert.deepEqual(sent, []);
  });
});

test('a launch under BROWSER_CPU_THROTTLE runs the page at the rate it names', async (t) => {
  const before = process.env.BROWSER_CPU_THROTTLE;
  process.env.BROWSER_CPU_THROTTLE = String(MEASURED_RATE);
  t.after(() => {
    if (before === undefined) delete process.env.BROWSER_CPU_THROTTLE;
    else process.env.BROWSER_CPU_THROTTLE = before;
  });

  const browser = await launchChrome(t, MAKES_NO_REQUESTS);
  const throttled = await quickestRun(browser.evaluate);
  await browser.call('Emulation.setCPUThrottlingRate', { rate: 1 });
  const full = await quickestRun(browser.evaluate);

  t.diagnostic(`${throttled.toFixed(1)} ms at ${MEASURED_RATE}x against ${full.toFixed(1)} ms at this machine's own speed`);
  assert.ok(
    throttled > full * LEAST_SLOWDOWN,
    `A page throttled ${MEASURED_RATE}x took ${throttled.toFixed(1)} ms against ${full.toFixed(1)} ms at full speed`,
  );
});
