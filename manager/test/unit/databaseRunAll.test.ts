/**
 * The rules the SQL runner refuses on, exercised without a database.
 *
 * The runner in test/database/run-all.mjs exists so that an unset variable or
 * a skipped suite can never be reported as a passing database check. Its
 * decisions are pure functions over an environment and over the child's own
 * summary lines, and this file is where they are pinned. The live run against
 * nine disposable databases is a separate thing and proves something else.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUITE_ARGS,
  TASK_DATABASES,
  connectionFor,
  databaseUrlFor,
  portProblems,
  runProblem,
  summaryOf,
} from '../database/run-all.mjs';

const NINE = {
  T01_TEST_PG_PORT: '55432',
  T04A_TEST_PG_PORT: '55432',
  T04B_TEST_PG_PORT: '55432',
  T06_TEST_PG_PORT: '55432',
  T08_TEST_PG_PORT: '55432',
  T09_TEST_PG_PORT: '55432',
  T10_TEST_PG_PORT: '55432',
  T11_TEST_PG_PORT: '55432',
  T12_TEST_PG_PORT: '55432',
};

const clean = { tests: 518, pass: 518, fail: 0, skipped: 0 };

describe('the table of task databases', () => {
  it('names the nine databases the SQL suites open, each with its own variable', () => {
    assert.deepEqual(
      TASK_DATABASES.map((entry) => entry.database),
      ['t01_test', 't04a_test', 't04b_test', 't06_test', 't08_test', 't09_test', 't10_test', 't11_test', 't12_test'],
    );
    assert.deepEqual(
      TASK_DATABASES.map((entry) => entry.variable),
      ['T01_TEST_PG_PORT', 'T04A_TEST_PG_PORT', 'T04B_TEST_PG_PORT', 'T06_TEST_PG_PORT', 'T08_TEST_PG_PORT',
        'T09_TEST_PG_PORT', 'T10_TEST_PG_PORT', 'T11_TEST_PG_PORT', 'T12_TEST_PG_PORT'],
    );
  });

  it('connects on loopback as postgres with a deadline, because the port is the whole configuration', () => {
    const connection = connectionFor({ database: 't09_test', variable: 'T09_TEST_PG_PORT' }, 55432);
    assert.equal(connection.host, '127.0.0.1');
    assert.equal(connection.user, 'postgres');
    assert.equal(connection.database, 't09_test');
    assert.equal(connection.port, 55432);
    assert.equal(connection.connectionTimeoutMillis, 10_000);
  });

  it('runs the suite files one at a time, because two of them read the clock while they hold locks', () => {
    assert.ok(SUITE_ARGS.includes('--test-concurrency=1'), SUITE_ARGS.join(' '));
    assert.ok(SUITE_ARGS.includes('--test-reporter=tap'), SUITE_ARGS.join(' '));
    assert.ok(SUITE_ARGS.includes('--conditions=development'), SUITE_ARGS.join(' '));
  });

  it('hands the child a DATABASE_URL that names a database the run created', () => {
    const url = databaseUrlFor(55432);
    assert.ok(url.includes('127.0.0.1:55432'), url);
    assert.ok(TASK_DATABASES.some((entry) => url.endsWith(`/${entry.database}`)), url);
  });
});

describe('refusing to start on the environment', () => {
  it('accepts nine ports', () => {
    assert.deepEqual(portProblems(NINE), []);
  });

  it('names the variable that is unset', () => {
    const { T09_TEST_PG_PORT: _unset, ...rest } = NINE;
    const problems = portProblems(rest);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /T09_TEST_PG_PORT/);
    assert.match(problems[0], /t09_test/);
    assert.match(problems[0], /not set/);
  });

  it('names every variable that is unset, not only the first', () => {
    assert.deepEqual(portProblems({}).length, 9);
    assert.ok(portProblems({}).every((problem, index) => problem.includes(TASK_DATABASES[index].variable)));
  });

  it('refuses an empty value the same way as an absent one', () => {
    const problems = portProblems({ ...NINE, T06_TEST_PG_PORT: '   ' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /T06_TEST_PG_PORT/);
  });

  for (const value of ['not-a-port', '5432abc', '5432.5', '0', '-1', '65536']) {
    it(`refuses ${JSON.stringify(value)} as a port`, () => {
      const problems = portProblems({ ...NINE, T11_TEST_PG_PORT: value });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /T11_TEST_PG_PORT/);
      assert.match(problems[0], /port number/);
    });
  }

  it('accepts the edges of the port range', () => {
    assert.deepEqual(portProblems({ ...NINE, T01_TEST_PG_PORT: '1', T12_TEST_PG_PORT: '65535' }), []);
  });
});

describe('reading the child summary', () => {
  const tail = [
    'ok 518 - the last one',
    '1..518',
    '# tests 518',
    '# suites 33',
    '# pass 518',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 128000',
    '',
  ].join('\n');

  it('reads the four counts a run is judged on', () => {
    assert.deepEqual(summaryOf(tail), clean);
  });

  it('ignores the indented summaries of nested subtests', () => {
    const nested = ['    # tests 3', '    # fail 2', '    # skipped 1', tail].join('\n');
    assert.deepEqual(summaryOf(nested), clean);
  });

  it('takes the last summary when a child prints more than one', () => {
    const twice = [tail, '# tests 4', '# pass 3', '# fail 1', '# skipped 0'].join('\n');
    assert.deepEqual(summaryOf(twice), { tests: 4, pass: 3, fail: 1, skipped: 0 });
  });

  it('reports a missing count as unknown rather than as zero', () => {
    assert.deepEqual(summaryOf('ok 1 - alone\n1..1\n'), { tests: null, pass: null, fail: null, skipped: null });
  });
});

describe('deciding whether the run was green', () => {
  it('passes a child that exited zero with no failure and no skip', () => {
    assert.equal(runProblem({ code: 0, signal: null, summary: clean }), null);
  });

  it('refuses a failure and prints all three counts', () => {
    const problem = runProblem({ code: 1, signal: null, summary: { ...clean, pass: 515, fail: 3 } });
    assert.match(problem ?? '', /3 failed/);
    assert.match(problem ?? '', /518 tests/);
    assert.match(problem ?? '', /0 skipped/);
  });

  it('refuses a skip, because a skipped suite is a suite that did not run', () => {
    const problem = runProblem({ code: 0, signal: null, summary: { ...clean, pass: 516, skipped: 2 } });
    assert.match(problem ?? '', /2 skipped/);
    assert.match(problem ?? '', /did not run/);
  });

  it('refuses a non-zero exit even when the counts look clean', () => {
    assert.match(runProblem({ code: 7, signal: null, summary: clean }) ?? '', /exited with code 7/);
  });

  it('refuses a child killed by a signal', () => {
    assert.match(runProblem({ code: null, signal: 'SIGKILL', summary: clean }) ?? '', /SIGKILL/);
  });

  it('refuses a run whose counts could not be read', () => {
    const problem = runProblem({ code: 0, signal: null, summary: { tests: null, pass: null, fail: null, skipped: null } });
    assert.match(problem ?? '', /summary/);
  });
});
