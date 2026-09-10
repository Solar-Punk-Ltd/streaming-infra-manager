/**
 * What a run of node's test runner has to look like before a runner calls it
 * green, shared by the two runners that watch a suite nothing else watches.
 *
 * Both the SQL suites and the browser suites gate themselves on an
 * environment variable and skip in silence without it, so both are run
 * through a script that refuses a skip. Node counts skipped *tests*, and a
 * suite skipped at the describe level registers no test at all: it prints
 * `# tests 0`, `# skipped 0` and a `# SKIP` marker on its own result line.
 * A glob that matched no file prints the same clean zero. So the counts alone
 * cannot tell a full run from an empty one, and these are the rules that can.
 *
 * Plain ESM with no dependency, imported by manager/test/database/run-all.mjs
 * and by frontend/test/run-all.mjs, so the two judge a run identically.
 */

/** The four counts a run is judged on. */
export const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'skipped'];

/** A count the child never printed, which is a reason to refuse rather than a zero. */
export const UNKNOWN = null;

/** A summary line, at column zero, so a nested subtest's own summary is not read as the run's. */
const SUMMARY_RE = /^# (tests|pass|fail|skipped) (\d+)$/gm;

/** A whole suite or file the runner skipped: `ok 3 - <name> # SKIP`, at column zero. */
const SKIPPED_SUITE_RE = /^(?:not )?ok +\d+ +- +(.*?) +# SKIP/gm;

/** The four counts the child's own summary reports, each null when it printed none. */
export function summaryOf(output) {
  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, UNKNOWN]));
  for (const [, key, value] of output.matchAll(SUMMARY_RE)) summary[key] = Number(value);
  return summary;
}

/** Every suite the run skipped whole, by the name it printed, and an empty list when none did. */
export function skippedSuitesIn(output) {
  return [...output.matchAll(SKIPPED_SUITE_RE)].map(([, name]) => name);
}

export function counted({ tests, fail, skipped }) {
  return `${tests} tests, ${fail} failed, ${skipped} skipped`;
}

/** The four counts of every file together, each unknown when any one file printed none. */
export function totalled(results) {
  const total = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, 0]));
  for (const { output } of results) {
    const summary = summaryOf(output);
    for (const key of SUMMARY_KEYS) {
      total[key] = total[key] === UNKNOWN || summary[key] === UNKNOWN ? UNKNOWN : total[key] + summary[key];
    }
  }
  return total;
}

/**
 * @typedef {object} FileRun what one suite file's child came back with.
 * @property {string} file the file it was asked to take.
 * @property {number | null} code the exit code, null when a signal ended it.
 * @property {string | null} signal what ended it, when something did.
 * @property {string} output the whole TAP body it printed.
 * @property {number} [timedOutAfterMs] the bound it outran, when the runner killed it at one.
 */

/**
 * Why a run of one child per file was not green, one line per file that was
 * not, and what every file together counted.
 *
 * A runner that gives each file a child of its own and a bound of its own can
 * say which file hung. That is the whole point of the shape: without it a
 * suite that never ends takes the job down with it and no other file's result
 * is ever reported.
 *
 * @param {{ results: FileRun[], glob: string }} run
 * @returns {{ problems: string[], summary: Record<string, number | null> }}
 */
export function judgeFiles({ results, glob }) {
  const problems = [];
  if (results.length === 0) {
    problems.push(`${glob} matched no file, and a run of nothing is not a pass.`);
  }
  for (const result of results) {
    if (result.timedOutAfterMs) {
      problems.push(
        `${result.file} was still running after ${result.timedOutAfterMs / 1000} s and was killed with its process group. ` +
          `A suite that hangs is a named failure here, never a cancelled job.`,
      );
      continue;
    }
    const problem = runProblem({ ...result, glob: result.file });
    if (problem) problems.push(`${result.file}: ${problem}`);
  }
  return { problems, summary: totalled(results) };
}

/**
 * Why the run was not green, in one line, or null.
 *
 * `output` is the whole TAP body and `glob` is what the run was asked to
 * take, because a run that took nothing has to say what it was looking for.
 */
export function runProblem({ code, signal, output, glob }) {
  const summary = summaryOf(output);
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
  const skippedSuites = skippedSuitesIn(output);
  if (skippedSuites.length > 0) {
    return (
      `${skippedSuites.length} suite(s) skipped themselves whole, which node counts as no test rather than as a skip: ` +
      `${skippedSuites.join(', ')}. ${counts}.`
    );
  }
  if (summary.tests === 0) {
    return `No test ran. ${glob} matched nothing that reported a test, and a run of nothing is not a pass. ${counts}.`;
  }
  return null;
}
