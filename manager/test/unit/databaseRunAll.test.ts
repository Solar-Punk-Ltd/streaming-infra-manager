/**
 * The rules the SQL runner refuses on, exercised without a database.
 *
 * The runner in test/database/run-all.mjs exists so that an unset variable or
 * a suite nothing ever started can never be reported as a passing database
 * check. Its decisions are pure functions over an environment and over the
 * suite files themselves, and this file is where they are pinned. How the run
 * is judged afterwards is shared with the browser runner and pinned in
 * tapJudge.test.ts. The live run against nine disposable databases is a third
 * thing and proves something else again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUITE_ARGS,
  TASK_DATABASES,
  connectionFor,
  databaseUrlFor,
  gateProblems,
  portProblems,
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

describe('refusing to start on a suite this run could never make answer', () => {
  const gated = (variable: string) => ({
    file: 'somethingNew.test.ts',
    text: `const port = Number(process.env.${variable});\ndescribe('x', { skip: !port }, () => {});\n`,
  });

  it('says nothing about the files that are gated on the table', () => {
    assert.deepEqual(gateProblems(TASK_DATABASES.map((entry) => gated(entry.variable))), []);
  });

  it('names the file and the variable when a suite is gated on a database this run does not create', () => {
    const problems = gateProblems([gated('T13_TEST_PG_PORT')]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /somethingNew\.test\.ts/);
    assert.match(problems[0], /T13_TEST_PG_PORT/);
    assert.match(problems[0], /skip in silence/);
  });

  it('names a file that reads no port variable at all, because its gate is not one this run sets', () => {
    const problems = gateProblems([{ file: 'ungated.test.ts', text: "describe('x', () => {});\n" }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ungated\.test\.ts/);
    assert.match(problems[0], /no task port variable/);
  });

  it('reads a file that names two variables as two answers, and refuses the one it cannot set', () => {
    const problems = gateProblems([
      { file: 'both.test.ts', text: 'T09_TEST_PG_PORT T13_TEST_PG_PORT T09_TEST_PG_PORT' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /T13_TEST_PG_PORT/);
  });
});
