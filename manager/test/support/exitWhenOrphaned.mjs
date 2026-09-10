/**
 * Ends a forked fixture when the process that started it is gone.
 *
 * A fixture normally ends because its parent closes the IPC channel. A parent
 * that is killed outright closes nothing it was going to close, and a parent
 * whose own teardown throws never gets there, so the fork keeps its port, its
 * database schema and its place in the runner until the job is cancelled.
 * `process.ppid` changes the moment the parent is reaped, to 1 or to whatever
 * reaper the container has, and that is the one thing an orphan can see about
 * a parent that told it nothing.
 *
 * Plain ESM with no dependency, so a fixture under tsx and a plain Node child
 * can both read it.
 */

/** Slow enough to cost a fixture nothing, quick enough that no job waits on it. */
export const ORPHAN_POLL_MS = 3000;

/**
 * @param {() => void} end what to do about it, called once.
 * @param {number} [everyMs] how often the parent is looked for.
 * @returns {NodeJS.Timeout} the watch, unreferenced, so it never holds the process open itself.
 */
export function exitWhenOrphaned(end, everyMs = ORPHAN_POLL_MS) {
  const startedBy = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid === startedBy) return;
    clearInterval(watch);
    end();
  }, everyMs);
  watch.unref();
  return watch;
}
