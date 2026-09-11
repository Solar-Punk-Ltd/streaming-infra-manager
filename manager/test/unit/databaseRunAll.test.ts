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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  SUITE_ARGS,
  TASK_DATABASES,
  connectionFor,
  databaseUrlFor,
  gateProblems,
  inspect,
  portProblems,
  preflightProblems,
  run,
  suiteFiles,
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

  it('reads a suite in a subdirectory, because the glob it protects is recursive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'suite-scan-'));
    try {
      mkdirSync(join(directory, 'nested'));
      writeFileSync(join(directory, 'top.test.ts'), 'process.env.T09_TEST_PG_PORT');
      writeFileSync(join(directory, 'nested', 'deep.test.ts'), 'process.env.T13_TEST_PG_PORT');
      writeFileSync(join(directory, 'nested', 'helper.ts'), 'not a suite file');

      const found = suiteFiles(directory);

      assert.deepEqual(
        found.map((suite) => suite.file),
        [join('nested', 'deep.test.ts'), 'top.test.ts'],
      );
      assert.match(gateProblems(found).join(' '), /T13_TEST_PG_PORT/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads a file that names two variables as two answers, and refuses the one it cannot set', () => {
    const problems = gateProblems([
      { file: 'both.test.ts', text: 'T09_TEST_PG_PORT T13_TEST_PG_PORT T09_TEST_PG_PORT' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /T13_TEST_PG_PORT/);
  });
});

describe('refusing to start on what the nine databases answered', () => {
  const entry = { database: 't09_test', variable: 'T09_TEST_PG_PORT', port: 55432 };
  const answered = { entry, error: null, managerTables: [] };

  /** A client that answers what the case says its public schema holds. */
  const clientAnswering = (tables: string[], failOn?: 'connect' | 'query') => () => ({
    connect: async () => {
      if (failOn === 'connect') throw new Error('connection refused');
    },
    query: async () => {
      if (failOn === 'query') throw new Error('server closed the connection');
      return { rows: tables.map((tablename) => ({ tablename })) };
    },
    end: async () => undefined,
  });

  it('says nothing about nine empty databases that answered', () => {
    assert.deepEqual(preflightProblems([answered, { ...answered, entry: { ...entry, database: 't01_test' } }]), []);
  });

  it('names the database, the variable and the address of one that did not answer', () => {
    const problems = preflightProblems([{ entry, error: new Error('connection refused'), managerTables: [] }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /t09_test/);
    assert.match(problems[0], /T09_TEST_PG_PORT/);
    assert.match(problems[0], /127\.0\.0\.1:55432/);
    assert.match(problems[0], /connection refused/);
  });

  it('refuses a database that already holds the manager own tables, because that is nobody disposable', () => {
    const problems = preflightProblems([{ entry, error: null, managerTables: ['_migrations', 'profiles'] }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /_migrations and profiles/);
    assert.match(problems[0], /t09_test/);
    assert.match(problems[0], /not a disposable one/);
  });

  it('reads those tables off a client that answers them, and refuses on what it read', async () => {
    const outcome = await inspect(entry, clientAnswering(['profiles']));
    assert.deepEqual(outcome.managerTables, ['profiles']);
    assert.equal(outcome.error, null);
    assert.match(preflightProblems([outcome]).join(' '), /profiles/);
  });

  it('reads an empty public schema as the disposable database it is', async () => {
    const outcome = await inspect(entry, clientAnswering([]));
    assert.deepEqual(outcome.managerTables, []);
    assert.deepEqual(preflightProblems([outcome]), []);
  });

  it('turns a client that cannot connect into the outcome the refusal is written from', async () => {
    const outcome = await inspect(entry, clientAnswering([], 'connect'));
    assert.match(String(outcome.error), /connection refused/);
    assert.match(preflightProblems([outcome]).join(' '), /did not answer/);
  });
});

describe('the gates the run consults, and the order it consults them in', () => {
  /** What a green child prints: enough of a summary for the shared judge to accept. */
  const GREEN = { code: 0, signal: null, output: '# tests 3\n# pass 3\n# fail 0\n# skipped 0\n' };

  /** One file, gated the way the nine real ones are, so the scan has nothing to say about it. */
  const GATED_ON_THE_TABLE = [{ file: 't09.test.ts', text: 'process.env.T09_TEST_PG_PORT' }];

  const emptyDatabase = () => ({
    connect: async () => undefined,
    query: async () => ({ rows: [] as Array<{ tablename: string }> }),
    end: async () => undefined,
  });
  const managerDatabase = () => ({
    ...emptyDatabase(),
    query: async () => ({ rows: [{ tablename: 'profiles' }] }),
  });

  const READ_THE_FILES = 'read the suite files';
  const OPEN_A_DATABASE = 'open a database';
  const START_THE_SUITES = 'start the suites';

  /**
   * A run over fakes, and the list of what it actually asked for.
   *
   * Every decision the runner makes is a pure function pinned above. What these
   * cases are about is that the run still calls them, in this order, and stops
   * at the first that refuses.
   */
  function drive(overrides: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const record =
      <Args extends unknown[], Result>(step: string, call: (...args: Args) => Result) =>
      (...args: Args): Result => {
        asked.push(step);
        return call(...args);
      };
    const parts = {
      env: { ...NINE },
      readSuites: () => GATED_ON_THE_TABLE,
      connect: emptyDatabase,
      spawnSuites: async () => GREEN,
      ...overrides,
    } as {
      env: Record<string, string>;
      readSuites: () => Array<{ file: string; text: string }>;
      connect: () => ReturnType<typeof emptyDatabase>;
      spawnSuites: () => Promise<typeof GREEN>;
    };
    const start = () =>
      run({
        env: parts.env,
        readSuites: record(READ_THE_FILES, parts.readSuites),
        connect: record(OPEN_A_DATABASE, parts.connect),
        spawnSuites: record(START_THE_SUITES, parts.spawnSuites),
        log: () => undefined,
      });
    return { asked, start };
  }

  it('reads every suite file, opens every database, then starts the suites', async () => {
    const { asked, start } = drive();

    assert.deepEqual(await start(), []);
    assert.deepEqual([...new Set(asked)], [READ_THE_FILES, OPEN_A_DATABASE, START_THE_SUITES]);
    assert.equal(asked.filter((step) => step === OPEN_A_DATABASE).length, TASK_DATABASES.length);
  });

  it('stops at a variable that is not set, before it reads a file or opens anything', async () => {
    const { T09_TEST_PG_PORT: _unset, ...eight } = NINE;
    const { asked, start } = drive({ env: eight });

    assert.match((await start()).join(' '), /T09_TEST_PG_PORT/);
    assert.deepEqual(asked, []);
  });

  it('stops at a suite it could never make answer, before it opens anything', async () => {
    const { asked, start } = drive({
      readSuites: () => [{ file: 'new.test.ts', text: 'process.env.T13_TEST_PG_PORT' }],
    });

    assert.match((await start()).join(' '), /T13_TEST_PG_PORT/);
    assert.deepEqual(asked, [READ_THE_FILES]);
  });

  it('stops at a database that is not disposable, before it starts a suite', async () => {
    const { asked, start } = drive({ connect: managerDatabase });

    assert.match((await start()).join(' '), /not a disposable one/);
    assert.equal(asked.includes(START_THE_SUITES), false, asked.join(', '));
  });

  it('refuses what the judge refuses, so a skipped test is not the end of a green run', async () => {
    const { start } = drive({
      spawnSuites: async () => ({ ...GREEN, output: '# tests 3\n# pass 2\n# fail 0\n# skipped 1\n' }),
    });

    assert.match((await start()).join(' '), /skipped suite is a suite that did not run/);
  });
});
