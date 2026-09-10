/**
 * Runs every SQL suite in this directory against nine disposable databases,
 * and refuses anything short of all of them running.
 *
 * Each suite file gates itself on a task port variable and skips silently when
 * that variable is unset, which on a runner would report a green database
 * check for a database nothing ever opened. So the configuration is checked
 * here first, every file's gate is read here first, every database is
 * connected to here first, and the run itself is judged by the shared rules in
 * test/support/tapJudge.mjs, which refuse a skipped test, a suite that skipped
 * itself whole, and a run that took no test at all.
 *
 * Usage, from the manager package, with a disposable PostgreSQL that already
 * holds the nine databases:
 *
 *   pnpm test:database
 *
 * The suites connect to 127.0.0.1 as postgres and nothing else, so the port is
 * the whole configuration. Never point these variables at a deployment
 * database: the preflight below refuses one that already holds the manager's
 * own tables, which is the check rather than this sentence.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { counted, runProblem, summaryOf } from '../support/tapJudge.mjs';

/**
 * The nine databases the suites in this directory open, and the variable each
 * reads its port from. This table is the only place that list lives, and
 * docs/ci.md points at it rather than repeating it.
 */
export const TASK_DATABASES = [
  { database: 't01_test', variable: 'T01_TEST_PG_PORT' },
  { database: 't04a_test', variable: 'T04A_TEST_PG_PORT' },
  { database: 't04b_test', variable: 'T04B_TEST_PG_PORT' },
  { database: 't06_test', variable: 'T06_TEST_PG_PORT' },
  { database: 't08_test', variable: 'T08_TEST_PG_PORT' },
  { database: 't09_test', variable: 'T09_TEST_PG_PORT' },
  { database: 't10_test', variable: 'T10_TEST_PG_PORT' },
  { database: 't11_test', variable: 'T11_TEST_PG_PORT' },
  { database: 't12_test', variable: 'T12_TEST_PG_PORT' },
];

/** The database whose URL the manager's config module gets, since it requires one at load. */
const CONFIG_DATABASE = 't04b_test';

const HOST = '127.0.0.1';
const USER = 'postgres';
const CONNECT_TIMEOUT_MS = 10_000;
const PORT_RE = /^\d{1,5}$/;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const SUITE_GLOB = 'test/database/**/*.test.ts';

/**
 * One file at a time. Measured here on 2026-09-10 against nine disposable
 * databases: with the runner's default file concurrency, two of four runs
 * failed, once on the lock-ordering case in chequebookTargets.test.ts and once
 * on the spent-budget deadline in chequebookConnected.test.ts. Both read the
 * clock while another connection holds a lock, so they lose to a loaded
 * machine rather than to a wrong rule. Serialized, three of three runs passed.
 * It costs about 115 seconds, and a required check that fails half the time is
 * worth more than that.
 */
export const SUITE_ARGS = [
  '--conditions=development',
  '--test',
  '--test-reporter=tap',
  '--test-concurrency=1',
  SUITE_GLOB,
];
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const SUITE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SUITE_FILE_SUFFIX = '.test.ts';

/** Every variable a suite file could be gated on, whether or not this job sets it. */
const PORT_VARIABLE_RE = /[A-Z0-9]+_TEST_PG_PORT/g;

/** The connection one suite would make, so the preflight opens exactly what the suite opens. */
export function connectionFor(entry, port) {
  return {
    host: HOST,
    port,
    user: USER,
    database: entry.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

export function databaseUrlFor(port) {
  return `postgres://${USER}@${HOST}:${port}/${CONFIG_DATABASE}`;
}

function portOf(env, variable) {
  const raw = (env[variable] ?? '').trim();
  if (raw === '') return { problem: 'unset' };
  if (!PORT_RE.test(raw)) return { problem: 'not a port' };
  const port = Number(raw);
  if (port < MIN_PORT || port > MAX_PORT) return { problem: 'not a port' };
  return { port };
}

/**
 * Why the runner must not start, one line per variable that cannot say where
 * its database is, or an empty list.
 */
export function portProblems(env) {
  const problems = [];
  for (const entry of TASK_DATABASES) {
    const { problem } = portOf(env, entry.variable);
    if (problem === 'unset') {
      problems.push(
        `${entry.variable} is not set, so the suites that open ${entry.database} would skip instead of running.`,
      );
    } else if (problem === 'not a port') {
      problems.push(
        `${entry.variable} is not a port number between ${MIN_PORT} and ${MAX_PORT}, and ${entry.database} is reached on ${HOST} at that port and nowhere else.`,
      );
    }
  }
  return problems;
}

/** The nine ports, read after portProblems came back empty. */
export function portsFrom(env) {
  return TASK_DATABASES.map((entry) => ({ ...entry, port: portOf(env, entry.variable).port }));
}

/**
 * Why a suite file in this directory could never run under this job, one line
 * each, or an empty list.
 *
 * A file gated on a variable the table does not carry skips itself whole, and
 * a suite that skips whole registers no test at all. The judge catches that
 * after the fact, from the marker on its result line. This catches it before
 * anything is started, and names the file rather than the suite, which is
 * what the person who has to add a database needs.
 */
export function gateProblems(suites) {
  const known = new Set(TASK_DATABASES.map((entry) => entry.variable));
  const problems = [];
  for (const { file, text } of suites) {
    const named = [...new Set([...text.matchAll(PORT_VARIABLE_RE)].map(([variable]) => variable))];
    if (named.length === 0) {
      problems.push(
        `${file} reads no task port variable, so nothing here knows which database it opens and this run cannot set it.`,
      );
      continue;
    }
    for (const variable of named.filter((variable) => !known.has(variable))) {
      problems.push(
        `${file} is gated on ${variable}, which is not one of the ${TASK_DATABASES.length} this run sets, ` +
          `so it would skip in silence. Add its database to the table in this file.`,
      );
    }
  }
  return problems;
}

/** Every suite file this run is about to start, with its text, for the gate scan. */
function suiteFiles() {
  return readdirSync(SUITE_DIR)
    .filter((file) => file.endsWith(SUITE_FILE_SUFFIX))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(SUITE_DIR, file), 'utf8') }));
}

/**
 * Tables that say a database belongs to a manager rather than to this run.
 *
 * A task database is created empty and every suite makes a schema of its own
 * in it, so nothing the suites do ever puts these in the public schema. Their
 * presence means the port leads somewhere that is not disposable.
 */
const MANAGER_TABLES = ['_migrations', 'profiles'];
const MANAGER_TABLE_QUERY =
  'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2)';
const PUBLIC_SCHEMA = 'public';

const openClient = (connection) => new pg.Client(connection);

/**
 * What one database said when the preflight opened it.
 *
 * The client is a parameter so the refusals can be exercised without a
 * PostgreSQL, and only the three calls below are asked of it.
 *
 * @param {{ database: string, variable: string, port: number }} entry
 * @param {(connection: unknown) => {
 *   connect: () => Promise<unknown>,
 *   query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ tablename: string }> }>,
 *   end: () => Promise<unknown>,
 * }} [connect]
 */
export async function inspect(entry, connect = openClient) {
  const client = connect(connectionFor(entry, entry.port));
  try {
    await client.connect();
    await client.query('SELECT 1');
    const answered = await client.query(MANAGER_TABLE_QUERY, [PUBLIC_SCHEMA, MANAGER_TABLES]);
    return { entry, error: null, managerTables: answered.rows.map((row) => row.tablename).sort() };
  } catch (error) {
    return { entry, error, managerTables: [] };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Why the run must not start on the databases it just opened, one line each,
 * or an empty list.
 *
 * Two things are asked of every one of them: that it answers, and that it is
 * not somebody's deployment. "Never point these variables at a deployment
 * database" was a sentence in this header and nothing else, and a port is easy
 * to mistype.
 */
export function preflightProblems(outcomes) {
  const problems = [];
  for (const { entry, error, managerTables } of outcomes) {
    if (error) {
      problems.push(
        `${entry.database} did not answer on ${HOST}:${entry.port} within ${CONNECT_TIMEOUT_MS / 1000} s ` +
          `(${entry.variable}): ${error instanceof Error ? error.message : String(error)}`,
      );
    } else if (managerTables.length > 0) {
      problems.push(
        `${entry.database} on ${HOST}:${entry.port} (${entry.variable}) already holds ${managerTables.join(' and ')} ` +
          `in its ${PUBLIC_SCHEMA} schema, so it is a manager's database and not a disposable one. ` +
          `These suites create and drop schemas, and this run will not do that to somebody's deployment.`,
      );
    }
  }
  return problems;
}

async function preflight(entries) {
  const outcomes = [];
  for (const entry of entries) outcomes.push(await inspect(entry));
  return preflightProblems(outcomes);
}

function runSuites(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, SUITE_ARGS, {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}

function refuse(problems) {
  for (const problem of problems) console.error(`REFUSED: ${problem}`);
  process.exitCode = 1;
}

async function main() {
  const configuration = portProblems(process.env);
  if (configuration.length > 0) return refuse(configuration);

  const gates = gateProblems(suiteFiles());
  if (gates.length > 0) return refuse(gates);

  const entries = portsFrom(process.env);
  const unreachable = await preflight(entries);
  if (unreachable.length > 0) return refuse(unreachable);
  console.log(`${entries.length} databases answered: ${entries.map((e) => `${e.database}:${e.port}`).join(' ')}`);

  const config = entries.find((entry) => entry.database === CONFIG_DATABASE);
  const result = await runSuites({ ...process.env, DATABASE_URL: databaseUrlFor(config.port) });
  const problem = runProblem({ ...result, glob: SUITE_GLOB });
  if (problem) return refuse([problem]);
  console.log(`PASS: ${counted(summaryOf(result.output))}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    refuse([`the runner itself failed: ${error instanceof Error ? error.message : String(error)}`]);
  });
}
