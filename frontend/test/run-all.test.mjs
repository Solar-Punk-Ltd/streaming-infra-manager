/**
 * What the browser runner refuses, exercised without a browser.
 *
 * It is the counterpart of the SQL runner: the suites here gate themselves on
 * an environment the job supplies, and a suite that skips itself whole leaves
 * the counts looking clean. The rules that judge the run are shared and
 * pinned in manager/test/unit/tapJudge.test.ts. What is this runner's own is
 * the browser it proves before it starts, the file list it takes, the bound
 * each of those files gets, and the arguments it starts them with.
 *
 * A Node-only file, run by the runner it is about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runProblem } from '../../manager/test/support/tapJudge.mjs';

import {
  DEFAULT_CHROME,
  suiteArgs,
  SUITE_GLOB,
  SUITE_TIMEOUT_MS,
  chromeFrom,
  chromeProblem,
  run,
  suiteFiles,
} from './run-all.mjs';

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

describe('the files it takes', () => {
  const files = suiteFiles();

  it('takes every suite file under test, and nothing else', () => {
    assert.ok(files.length > 20, files.join(' '));
    assert.deepEqual(files.filter((file) => !file.startsWith('test/') || !file.endsWith('.test.mjs')), []);
  });

  it('takes them in one settled order, so a failure is always the same run', () => {
    assert.deepEqual(files, [...files].sort());
  });

  it('reaches the ones a directory down, which the glob it stands for also reaches', () => {
    assert.ok(files.includes('test/support/chrome-wait.test.mjs'), files.join(' '));
    assert.ok(files.includes('test/readiness-browser.test.mjs'), files.join(' '));
  });
});

describe('how it starts one file', () => {
  const args = suiteArgs('test/readiness-browser.test.mjs');

  it('gives the file its own child, under tsx, reporting TAP', () => {
    assert.equal(args.at(-1), 'test/readiness-browser.test.mjs');
    assert.ok(args.includes('--test-reporter=tap'), args.join(' '));
    assert.ok(args.includes('--conditions=development'), args.join(' '));
    assert.equal(args[args.indexOf('--import') + 1], 'tsx');
  });

  it('bounds it at ten minutes, which is longer than any suite has ever taken', () => {
    assert.equal(SUITE_TIMEOUT_MS, 600_000);
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

describe('the gates it consults, and the order it consults them in', () => {
  const PROVE_THE_BROWSER = 'prove the browser';
  const LIST_THE_FILES = 'list the files';
  const START_A_SUITE = 'start a suite';
  const GREEN = { code: 0, signal: null, output: '# tests 3\n# pass 3\n# fail 0\n# skipped 0\n' };

  /**
   * A run over fakes, and the list of what it actually asked for.
   *
   * Its decisions are pure functions pinned above and in the judge's own
   * suite. What these cases are about is that the run still calls them, in
   * this order, that a browser it cannot find ends it before a file is
   * started, and that every file it was given gets a child of its own.
   */
  function drive(overrides = {}) {
    const asked = [];
    const started = [];
    const lines = [];
    const record = (step, call) => (...args) => {
      asked.push(step);
      return call(...args);
    };
    const parts = {
      env: { CHROME_BIN: '/usr/bin/google-chrome' },
      canExecute: EVERYTHING_EXECUTABLE,
      readSuites: () => ['test/only.test.mjs'],
      spawnSuite: async (file) => ({ file, ...GREEN }),
      ...overrides,
    };
    const start = () =>
      run({
        env: parts.env,
        canExecute: record(PROVE_THE_BROWSER, parts.canExecute),
        readSuites: record(LIST_THE_FILES, parts.readSuites),
        spawnSuite: record(START_A_SUITE, (file, env) => {
          started.push(file);
          return parts.spawnSuite(file, env);
        }),
        log: (line) => lines.push(line),
      });
    return { asked, started, lines, start };
  }

  it('proves the browser first, then lists the files, then starts them', async () => {
    const { asked, start } = drive();

    assert.deepEqual(await start(), []);
    assert.deepEqual(asked, [PROVE_THE_BROWSER, LIST_THE_FILES, START_A_SUITE]);
  });

  it('stops at a browser that is not there, before it lists or starts anything', async () => {
    const { asked, start } = drive({ canExecute: NOTHING_EXECUTABLE });

    assert.match((await start()).join(' '), /failed check and never a passed one/);
    assert.deepEqual(asked, [PROVE_THE_BROWSER]);
  });

  it('gives every file a child of its own, in the order the list came in', async () => {
    const files = ['test/a.test.mjs', 'test/b.test.mjs', 'test/support/c.test.mjs'];
    const { started, start } = drive({ readSuites: () => files });

    assert.deepEqual(await start(), []);
    assert.deepEqual(started, files);
  });

  it('adds up what the files counted rather than reporting the last one', async () => {
    const { lines, start } = drive({ readSuites: () => ['test/a.test.mjs', 'test/b.test.mjs'] });

    assert.deepEqual(await start(), []);
    assert.ok(lines.some((line) => line.startsWith('PASS: 6 tests, 0 failed, 0 skipped')), lines.join(' | '));
  });

  it('refuses a file that outran its bound, by name, rather than letting the job be cancelled', async () => {
    const { start } = drive({
      readSuites: () => ['test/quick.test.mjs', 'test/hangs.test.mjs'],
      spawnSuite: async (file) =>
        file === 'test/hangs.test.mjs'
          ? { file, code: null, signal: 'SIGKILL', output: '', timedOutAfterMs: SUITE_TIMEOUT_MS }
          : { file, ...GREEN },
    });

    const problems = await start();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /test\/hangs\.test\.mjs/);
    assert.match(problems[0], /600 s/);
  });

  it('keeps the judge verdict rather than discarding it, so a skipped suite is not a pass', async () => {
    const skipped = [
      'ok 12 - a real deposit reaches settlement in the dialog without a click # SKIP T09_TEST_PG_PORT is not set',
      '# tests 141\n# pass 141\n# fail 0\n# skipped 0',
    ].join('\n');
    const { start } = drive({ spawnSuite: async (file) => ({ file, ...GREEN, output: skipped }) });

    assert.match((await start()).join(' '), /a real deposit reaches settlement/);
  });

  it('refuses a run with no file to take, naming what it was looking for', async () => {
    const { start } = drive({ readSuites: () => [] });

    assert.match((await start()).join(' '), /test\/\*\*\/\*\.test\.mjs/);
  });

  it('names the throttle every browser session will run under', async () => {
    const { lines, start } = drive({ env: { CHROME_BIN: '/usr/bin/google-chrome', BROWSER_CPU_THROTTLE: '4' } });

    assert.deepEqual(await start(), []);
    assert.ok(
      lines.includes("CPU throttle: every browser session runs at 1/4 of this machine's speed"),
      lines.join(' | '),
    );
  });

  it('says nothing about a throttle when the environment asks for none', async () => {
    const { lines, start } = drive();

    assert.deepEqual(await start(), []);
    assert.deepEqual(lines.filter((line) => /throttle/i.test(line)), []);
  });

  it('hands every suite child the environment it was given, the throttle with it', async () => {
    const env = { CHROME_BIN: '/usr/bin/google-chrome', BROWSER_CPU_THROTTLE: '6' };
    const handed = [];
    const { start } = drive({
      env,
      spawnSuite: async (file, suiteEnv) => {
        handed.push(suiteEnv);
        return { file, ...GREEN };
      },
    });

    assert.deepEqual(await start(), []);
    assert.deepEqual(handed, [env]);
  });

  it('looks for the browser the environment names, and nowhere else', async () => {
    const looked = [];
    const { start } = drive({
      env: { CHROME_BIN: '/opt/chrome/chrome' },
      canExecute: (path) => {
        looked.push(path);
        return true;
      },
    });

    await start();
    assert.deepEqual(looked, ['/opt/chrome/chrome']);
  });
});
