/**
 * Runs every SQL suite in this directory against nine disposable databases,
 * and refuses anything short of all of them running.
 *
 * Each suite file gates itself on a task port variable and skips silently when
 * that variable is unset, which on a runner would report a green database
 * check for a database nothing ever opened. So the configuration is checked
 * here first, every database is connected to here first, and a run whose
 * summary carries a single skip is not a pass.
 *
 * Usage, from the manager package, with a disposable PostgreSQL that already
 * holds the nine databases:
 *
 *   pnpm test:database
 *
 * The suites connect to 127.0.0.1 as postgres and nothing else, so the port is
 * the whole configuration. Never point these variables at a deployment
 * database.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

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

/** A count the child never printed, which is a reason to refuse rather than a zero. */
const UNKNOWN = null;

const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'skipped'];
const SUMMARY_RE = /^# (tests|pass|fail|skipped) (\d+)$/gm;

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

/** The four counts the child's own summary reports, each null when it printed none. */
export function summaryOf(output) {
  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, UNKNOWN]));
  for (const [, key, value] of output.matchAll(SUMMARY_RE)) summary[key] = Number(value);
  return summary;
}

function counted({ tests, fail, skipped }) {
  return `${tests} tests, ${fail} failed, ${skipped} skipped`;
}

/** Why the run was not green, in one line carrying all three counts, or null. */
export function runProblem({ code, signal, summary }) {
  if (SUMMARY_KEYS.some((key) => summary[key] === UNKNOWN)) {
    return 'The child printed no summary, so nothing here knows what ran. Its output is above.';
  }
  const counts = counted(summary);
  if (signal) return `The suites were killed by ${signal}. ${counts}.`;
  if (code !== 0) return `The suites exited with code ${code}. ${counts}.`;
  if (summary.fail !== 0) return `The suites reported failures. ${counts}.`;
  if (summary.skipped !== 0) {
    return `A skipped suite is a suite that did not run, and this runner exists so that is never counted as green. ${counts}.`;
  }
  return null;
}

async function preflight(entries) {
  const problems = [];
  for (const entry of entries) {
    const client = new pg.Client(connectionFor(entry, entry.port));
    try {
      await client.connect();
      await client.query('SELECT 1');
    } catch (error) {
      problems.push(
        `${entry.database} did not answer on ${HOST}:${entry.port} within ${CONNECT_TIMEOUT_MS / 1000} s ` +
          `(${entry.variable}): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  return problems;
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
    child.on('close', (code, signal) => resolve({ code, signal, summary: summaryOf(output) }));
  });
}

function refuse(problems) {
  for (const problem of problems) console.error(`REFUSED: ${problem}`);
  process.exitCode = 1;
}

async function main() {
  const configuration = portProblems(process.env);
  if (configuration.length > 0) return refuse(configuration);

  const entries = portsFrom(process.env);
  const unreachable = await preflight(entries);
  if (unreachable.length > 0) return refuse(unreachable);
  console.log(`${entries.length} databases answered: ${entries.map((e) => `${e.database}:${e.port}`).join(' ')}`);

  const config = entries.find((entry) => entry.database === CONFIG_DATABASE);
  const result = await runSuites({ ...process.env, DATABASE_URL: databaseUrlFor(config.port) });
  const problem = runProblem(result);
  if (problem) return refuse([problem]);
  console.log(`PASS: ${counted(result.summary)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    refuse([`the runner itself failed: ${error instanceof Error ? error.message : String(error)}`]);
  });
}
