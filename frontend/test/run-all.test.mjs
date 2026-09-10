/**
 * What the browser runner refuses, exercised without a browser.
 *
 * It is the counterpart of the SQL runner: the suites here gate themselves on
 * an environment the job supplies, and a suite that skips itself whole leaves
 * the counts looking clean. The rules that judge the run are shared and
 * pinned in manager/test/unit/tapJudge.test.ts. What is this runner's own is
 * the browser it proves before it starts, and the arguments it starts the
 * suites with.
 *
 * A Node-only file, run by the runner it is about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runProblem } from '../../manager/test/support/tapJudge.mjs';

import { DEFAULT_CHROME, SUITE_ARGS, SUITE_GLOB, chromeFrom, chromeProblem } from './run-all.mjs';

const NOTHING_EXECUTABLE = () => false;
const EVERYTHING_EXECUTABLE = () => true;

describe('the browser it proves before it starts', () => {
  it('takes CHROME_BIN when the environment names one', () => {
    assert.equal(chromeFrom({ CHROME_BIN: '/usr/bin/google-chrome' }), '/usr/bin/google-chrome');
  });

  it('falls back to the path this laptop keeps Chrome at', () => {
    assert.equal(chromeFrom({}), DEFAULT_CHROME);
  });

  it('refuses in words when nothing executable is there, naming the path it looked at', () => {
    const problem = chromeProblem('/no/such/chrome', NOTHING_EXECUTABLE);
    assert.match(problem ?? '', /\/no\/such\/chrome/);
    assert.match(problem ?? '', /failed check and never a passed one/);
    assert.match(problem ?? '', /CHROME_BIN/);
  });

  it('says nothing when the browser is there', () => {
    assert.equal(chromeProblem('/usr/bin/google-chrome', EVERYTHING_EXECUTABLE), null);
  });
});

describe('how it starts the suites', () => {
  it('runs them one at a time, under tsx, reporting TAP', () => {
    assert.ok(SUITE_ARGS.includes('--test-concurrency=1'), SUITE_ARGS.join(' '));
    assert.ok(SUITE_ARGS.includes('--test-reporter=tap'), SUITE_ARGS.join(' '));
    assert.ok(SUITE_ARGS.includes('--conditions=development'), SUITE_ARGS.join(' '));
    assert.equal(SUITE_ARGS[SUITE_ARGS.indexOf('--import') + 1], 'tsx');
    assert.ok(SUITE_ARGS.includes(SUITE_GLOB), SUITE_ARGS.join(' '));
  });
});

describe('the rules it judges the run by, which are the SQL runner rules', () => {
  const summary = (counts) =>
    ['# tests', '# pass', '# fail', '# skipped']
      .map((key, index) => `${key} ${counts[index]}`)
      .join('\n');

  it('refuses the three connected cases skipping themselves', () => {
    const output = [
      'ok 12 - a real deposit reaches settlement in the dialog without a click # SKIP T09_TEST_PG_PORT is not set',
      summary([141, 141, 0, 0]),
    ].join('\n');
    const problem = runProblem({ code: 0, signal: null, output, glob: SUITE_GLOB });
    assert.match(problem ?? '', /a real deposit reaches settlement/);
  });

  it('refuses a run that took no suite at all, naming the glob', () => {
    const problem = runProblem({ code: 0, signal: null, output: summary([0, 0, 0, 0]), glob: SUITE_GLOB });
    assert.match(problem ?? '', /No test ran/);
    assert.match(problem ?? '', /test\/\*\*\/\*\.test\.mjs/);
  });

  it('passes a full run', () => {
    assert.equal(runProblem({ code: 0, signal: null, output: summary([144, 144, 0, 0]), glob: SUITE_GLOB }), null);
  });
});
