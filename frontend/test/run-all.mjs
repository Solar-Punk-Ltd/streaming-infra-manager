/**
 * Runs every suite in this directory, one file at a time, and refuses
 * anything short of all of them running.
 *
 * Fourteen of them drive a real headless Chrome against a real Vite, one
 * drives a Chrome and no Vite, several need neither, and one drives the
 * protocol client itself. They live outside
 * `pnpm test`, which only takes src, so until the browser job existed they
 * ran nowhere on a pull request. Two things can turn that job green while it
 * proves nothing: transfer-connected-browser.test.mjs skips its three cases
 * when T09_TEST_PG_PORT is unset, and a suite that skips itself whole
 * registers no test at all, so the counts stay clean. The rules that catch
 * both are shared with the SQL runner, in manager/test/support/tapJudge.mjs,
 * so the two judge a run the same way and cannot drift apart.
 *
 * Each file gets a child of its own and a bound of its own, because on the
 * job's first run one file never ended and took the whole thirty minute job
 * with it, reporting nothing about the other twenty-two. A file that outruns
 * its bound is killed with its process group and named here instead.
 *
 * Chrome is proved before anything starts, because a browser that is not
 * there has to be a failed check and never a passed one.
 *
 * Usage, from the frontend package:
 *
 *   pnpm test:browser
 *
 * `BROWSER_CPU_THROTTLE=4` runs every page session at a quarter of this
 * machine's speed, which is how the runner's two cores are reproduced here.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { counted, judgeFiles } from '../../manager/test/support/tapJudge.mjs';

import { cpuThrottleRate } from './support/chrome.mjs';

/** Where the suites look when CHROME_BIN says nothing, which is this laptop. */
export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const SUITE_GLOB = 'test/**/*.test.mjs';
const SUITE_SUFFIX = '.test.mjs';

/**
 * What one file gets before the runner stops waiting for it.
 *
 * The longest single test on this laptop is a Chrome suite at 43 seconds and
 * the whole set takes about six minutes, so ten minutes for one file is a hang
 * and not a slow runner.
 */
export const SUITE_TIMEOUT_MS = 600_000;

/**
 * One child per file, under tsx because mock-engine-observations.test.mjs
 * reaches the manager's TypeScript through dev/mock-engine.mjs, whose .js
 * specifiers only tsx rewrites.
 */
export function suiteArgs(file) {
  return ['--import', 'tsx', '--conditions=development', '--test', '--test-reporter=tap', file];
}

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const TEST_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));

/** The two ways an interrupted run arrives: a terminal's Ctrl-C, and a runner stopping a job. */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'];

/** Every suite file the glob above stands for, in the one order this runner takes them. */
export function suiteFiles(directory = TEST_DIRECTORY) {
  return readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith(SUITE_SUFFIX))
    .sort()
    .map((name) => `test/${name}`);
}

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

/**
 * Ends the child and everything it started.
 *
 * A suite file's child forks a Vite and starts a Chrome of its own, and the
 * ones that are still there are exactly the reason it is being killed, so the
 * signal goes to the group rather than to the one process this runner holds.
 */
function endTree(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

function runSuite(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, suiteArgs(file), {
      cwd: PACKAGE,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: true,
    });
    let output = '';
    let timedOutAfterMs = 0;
    const bound = setTimeout(() => {
      timedOutAfterMs = SUITE_TIMEOUT_MS;
      endTree(child, 'SIGKILL');
    }, SUITE_TIMEOUT_MS);
    const forward = (signal) => () => endTree(child, signal);
    const forwarding = FORWARDED_SIGNALS.map((signal) => ({ signal, listener: forward(signal) }));
    for (const { signal, listener } of forwarding) process.on(signal, listener);
    const done = () => {
      clearTimeout(bound);
      for (const { signal, listener } of forwarding) process.off(signal, listener);
    };
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.on('error', (error) => {
      done();
      reject(error);
    });
    child.on('close', (code, signal) => {
      done();
      resolve({ file, code, signal, output, timedOutAfterMs });
    });
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
 * @property {() => string[]} readSuites every suite file this run takes, in order.
 * @property {(file: string, env: Record<string, string | undefined>) => Promise<import('../../manager/test/support/tapJudge.mjs').FileRun>} spawnSuite one file's child, run to the end or to its bound.
 * @property {(line: string) => void} log where the lines a run prints go.
 */

/**
 * The whole run, over the pieces it needs from outside itself.
 *
 * The decisions are pure functions pinned in run-all.test.mjs and in the
 * judge's own suite, and the order is a guarantee of its own: the browser is
 * proved before a file is started, every file gets a child, and the judge's
 * verdict is what the run returns rather than something it looks at. Handing
 * those in rather than reaching for them is what lets a test drive that order
 * without a browser and without starting anything.
 *
 * @param {Dependencies} dependencies
 * @returns {Promise<string[]>} every reason this run is not green, or an empty list.
 */
export async function run({ env, canExecute, readSuites, spawnSuite, log }) {
  const chrome = chromeFrom(env);
  const unusable = chromeProblem(chrome, canExecute);
  if (unusable) return [unusable];
  log(`Chrome: ${chrome}`);
  const throttle = cpuThrottleRate(env);
  if (throttle !== null) log(`CPU throttle: every browser session runs at 1/${throttle} of this machine's speed`);

  const files = readSuites();
  const results = [];
  for (const file of files) {
    log(`SUITE: ${file}`);
    results.push(await spawnSuite(file, env));
  }

  const { problems, summary } = judgeFiles({ results, glob: SUITE_GLOB });
  if (problems.length > 0) return problems;
  log(`PASS: ${counted(summary)}, across ${files.length} suite files`);
  return [];
}

/** @returns {Dependencies} the real pieces, which is all the entry point below adds. */
function realDependencies() {
  return {
    env: process.env,
    canExecute: isExecutable,
    readSuites: suiteFiles,
    spawnSuite: runSuite,
    log: (line) => console.log(line),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await run(realDependencies()).catch((error) => [
    `the runner itself failed: ${error instanceof Error ? error.message : String(error)}`,
  ]);
  if (problems.length > 0) refuse(problems);
}
