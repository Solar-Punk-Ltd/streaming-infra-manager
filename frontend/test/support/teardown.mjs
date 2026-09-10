/**
 * A teardown that cannot skip its own work.
 *
 * Node's test runner stops at the first `after` hook that throws, so anything
 * a hook has left to do is left undone and no later hook runs at all. What
 * that costs is not tidiness: a child process or an open server keeps the test
 * file's process alive, `node --test` waits for that file forever, and the job
 * is cancelled at its limit rather than failing at the suite that broke. That
 * is what the browser job's first run did.
 *
 * @param {Array<() => unknown>} steps run in order, each on its own.
 * @returns {Promise<void>} rejecting with the first failure once every step has had its turn.
 */
export async function runEveryStep(steps) {
  let failure = null;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
