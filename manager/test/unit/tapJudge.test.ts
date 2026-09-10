/**
 * The rules both suite runners judge a run by, exercised on TAP bodies node
 * really printed.
 *
 * The counts alone cannot tell a full run from an empty one. A suite skipped
 * at the describe level registers no test, so it prints `# tests 0`,
 * `# skipped 0` and a `# SKIP` marker on its own result line, and a glob that
 * matches no file prints the same clean zero. Both were reproduced against
 * the real SQL suites: 33 skipped files came back as `# tests 0 # fail 0
 * # skipped 0` and the runner called it a pass. These are the rules that
 * refuse each of them, and this file is where they are pinned.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  counted,
  runProblem,
  skippedSuitesIn,
  summaryOf,
} from '../support/tapJudge.mjs';

const GLOB = 'test/database/**/*.test.ts';

/** A summary the way node prints it, with the counts a caller wants to try. */
function tap({ tests = 518, pass = 518, fail = 0, skipped = 0, body = 'ok 1 - a suite that ran\n' }) {
  return [
    body,
    `# tests ${tests}`,
    '# suites 33',
    `# pass ${pass}`,
    `# fail ${fail}`,
    '# cancelled 0',
    `# skipped ${skipped}`,
    '# todo 0',
    '# duration_ms 128000',
    '',
  ].join('\n');
}

/** What node printed for two of the SQL suites with their port variables unset. */
const SKIPPED_BODY = [
  '# Subtest: chequebook operations in isolated PostgreSQL schemas',
  'ok 1 - chequebook operations in isolated PostgreSQL schemas # SKIP',
  '# Subtest: port reservations in isolated PostgreSQL schemas',
  'ok 2 - port reservations in isolated PostgreSQL schemas # SKIP',
  '1..2',
].join('\n');

const green = { code: 0, signal: null, output: tap({}), glob: GLOB };

describe('reading the child summary', () => {
  it('reads the four counts a run is judged on', () => {
    assert.deepEqual(summaryOf(tap({})), { tests: 518, pass: 518, fail: 0, skipped: 0 });
  });

  it('ignores the indented summaries of nested subtests', () => {
    const nested = ['    # tests 3', '    # fail 2', '    # skipped 1', tap({})].join('\n');
    assert.deepEqual(summaryOf(nested), { tests: 518, pass: 518, fail: 0, skipped: 0 });
  });

  it('takes the last summary when a child prints more than one', () => {
    const twice = [tap({}), '# tests 4', '# pass 3', '# fail 1', '# skipped 0'].join('\n');
    assert.deepEqual(summaryOf(twice), { tests: 4, pass: 3, fail: 1, skipped: 0 });
  });

  it('reports a missing count as unknown rather than as zero', () => {
    assert.deepEqual(summaryOf('ok 1 - alone\n1..1\n'), { tests: null, pass: null, fail: null, skipped: null });
  });

  it('says all three counts in one line', () => {
    assert.equal(counted({ tests: 518, fail: 2, skipped: 1 }), '518 tests, 2 failed, 1 skipped');
  });
});

describe('finding the suites that skipped themselves whole', () => {
  it('names each one, by the name node printed', () => {
    assert.deepEqual(skippedSuitesIn(SKIPPED_BODY), [
      'chequebook operations in isolated PostgreSQL schemas',
      'port reservations in isolated PostgreSQL schemas',
    ]);
  });

  it('finds none in a run where every suite ran', () => {
    assert.deepEqual(skippedSuitesIn(tap({})), []);
  });

  it('reads a failed skipped suite too, because not ok carries the marker the same way', () => {
    assert.deepEqual(skippedSuitesIn('not ok 4 - a suite that skipped # SKIP\n'), ['a suite that skipped']);
  });

  it('leaves a test whose own name merely mentions skipping alone', () => {
    assert.deepEqual(skippedSuitesIn('ok 7 - refuses to SKIP a suite\n'), []);
  });
});

describe('deciding whether the run was green', () => {
  it('passes a child that exited zero with tests, no failure and no skip', () => {
    assert.equal(runProblem(green), null);
  });

  it('refuses a failure and prints all three counts', () => {
    const problem = runProblem({ ...green, code: 1, output: tap({ pass: 515, fail: 3 }) });
    assert.match(problem ?? '', /3 failed/);
    assert.match(problem ?? '', /518 tests/);
    assert.match(problem ?? '', /0 skipped/);
  });

  it('refuses a skipped test, because a skipped suite is a suite that did not run', () => {
    const problem = runProblem({ ...green, output: tap({ pass: 516, skipped: 2 }) });
    assert.match(problem ?? '', /2 skipped/);
    assert.match(problem ?? '', /did not run/);
  });

  it('refuses a non-zero exit even when the counts look clean', () => {
    assert.match(runProblem({ ...green, code: 7 }) ?? '', /exited with code 7/);
  });

  it('refuses a child killed by a signal', () => {
    assert.match(runProblem({ ...green, code: null, signal: 'SIGKILL' }) ?? '', /SIGKILL/);
  });

  it('refuses a run whose counts could not be read', () => {
    assert.match(runProblem({ ...green, output: 'ok 1 - alone\n' }) ?? '', /summary/);
  });

  it('refuses suites that skipped themselves whole, which node counts as no test at all', () => {
    const problem = runProblem({ ...green, output: tap({ tests: 0, pass: 0, body: SKIPPED_BODY }) });
    assert.match(problem ?? '', /chequebook operations in isolated PostgreSQL schemas/);
    assert.match(problem ?? '', /port reservations in isolated PostgreSQL schemas/);
  });

  it('refuses a suite that skipped itself whole even where other suites ran', () => {
    const problem = runProblem({ ...green, output: tap({ body: `ok 1 - one that ran\n${SKIPPED_BODY}` }) });
    assert.match(problem ?? '', /chequebook operations/);
  });

  it('refuses a run of no tests at all, naming what it was asked to take', () => {
    const problem = runProblem({ ...green, output: tap({ tests: 0, pass: 0, body: '1..0\n' }) });
    assert.match(problem ?? '', /No test ran/);
    assert.match(problem ?? '', new RegExp(GLOB.replace(/[*/.]/g, '\\$&')));
  });
});
