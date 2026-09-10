/**
 * Runs every suite in this directory, and refuses anything short of all of
 * them running.
 *
 * Fourteen of them drive a real headless Chrome against a real Vite, five
 * need neither, and one drives the protocol client itself. They live outside
 * `pnpm test`, which only takes src, so until the browser job existed they
 * ran nowhere on a pull request. Two things can turn that job green while it
 * proves nothing: transfer-connected-browser.test.mjs skips its three cases
 * when T09_TEST_PG_PORT is unset, and a suite that skips itself whole
 * registers no test at all, so the counts stay clean. The rules that catch
 * both are shared with the SQL runner, in manager/test/support/tapJudge.mjs,
 * so the two judge a run the same way and cannot drift apart.
 *
 * Chrome is proved before anything starts, because a browser that is not
 * there has to be a failed check and never a passed one.
 *
 * Usage, from the frontend package:
 *
 *   pnpm test:browser
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { counted, runProblem, summaryOf } from '../../manager/test/support/tapJudge.mjs';

/** Where the suites look when CHROME_BIN says nothing, which is this laptop. */
export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const SUITE_GLOB = 'test/**/*.test.mjs';

/**
 * One file at a time, because each Chrome suite starts a Vite and a Chrome of
 * its own. Under tsx because mock-engine-observations.test.mjs reaches the
 * manager's TypeScript through dev/mock-engine.mjs, whose .js specifiers only
 * tsx rewrites.
 */
export const SUITE_ARGS = [
  '--import',
  'tsx',
  '--conditions=development',
  '--test',
  '--test-reporter=tap',
  '--test-concurrency=1',
  SUITE_GLOB,
];

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

/** The browser these suites drive, from the environment or the default above. */
export function chromeFrom(env) {
  return env.CHROME_BIN ?? DEFAULT_CHROME;
}

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Why the browser suites must not start, in words, or null. */
export function chromeProblem(path, canExecute = isExecutable) {
  if (canExecute(path)) return null;
  return (
    `No executable browser at ${path}. Most of these suites drive a real Chrome, ` +
    `so this is a failed check and never a passed one. Set CHROME_BIN to the browser's own path.`
  );
}

function runSuites(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, SUITE_ARGS, {
      cwd: PACKAGE,
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

/**
 * @typedef {object} Dependencies
 * @property {Record<string, string | undefined>} env where the browser's path is read from.
 * @property {(path: string) => boolean} canExecute whether that path is a browser this run can start.
 * @property {(env: Record<string, string | undefined>) => Promise<{ code: number | null, signal: string | null, output: string }>} spawnSuites the child, run to the end.
 * @property {(line: string) => void} log where the two lines a green run prints go.
 */

/**
 * The whole run, over the pieces it needs from outside itself.
 *
 * Both decisions are pure functions pinned in run-all.test.mjs, and the order
 * is a guarantee of its own: the browser is proved before a suite is started,
 * and the judge's verdict is what the run returns rather than something it
 * looks at. Handing those in rather than reaching for them is what lets a test
 * drive that order without a browser and without starting anything.
 *
 * @param {Dependencies} dependencies
 * @returns {Promise<string[]>} every reason this run is not green, or an empty list.
 */
export async function run({ env, canExecute, spawnSuites, log }) {
  const chrome = chromeFrom(env);
  const unusable = chromeProblem(chrome, canExecute);
  if (unusable) return [unusable];
  log(`Chrome: ${chrome}`);

  const result = await spawnSuites(env);
  const problem = runProblem({ ...result, glob: SUITE_GLOB });
  if (problem) return [problem];
  log(`PASS: ${counted(summaryOf(result.output))}`);
  return [];
}

/** @returns {Dependencies} the real pieces, which is all the entry point below adds. */
function realDependencies() {
  return {
    env: process.env,
    canExecute: isExecutable,
    spawnSuites: runSuites,
    log: (line) => console.log(line),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await run(realDependencies()).catch((error) => [
    `the runner itself failed: ${error instanceof Error ? error.message : String(error)}`,
  ]);
  if (problems.length > 0) refuse(problems);
}
