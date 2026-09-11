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

/** Long enough for a server that is going to close, short enough that a suite ends rather than the run. */
const VITE_CLOSE_BUDGET_MS = 10_000;

/**
 * Ends a Vite dev server in a way that cannot strand the browser beside it.
 *
 * Node runs a test's `after` hooks in registration order and stops at the
 * first one that throws, so every hook behind it is left undone. The five
 * suites that own a Vite directly register its teardown before `launchChrome`
 * registers Chrome's, so a Vite close that throws or never resolves leaves a
 * detached browser running and its socket open, and the file never exits. The
 * runner then kills it at its per-file bound, ten minutes after the tests
 * themselves reported. Measured on 2026-09-11: a teardown made to throw left
 * the file running with no summary printed and Chrome alive.
 *
 * So this one never throws and always answers. A close that will not finish
 * costs a suite its bound. Not bounding it costs the whole run its remaining
 * minutes. What went wrong reaches the log as a diagnostic, which is a failing
 * suite's evidence without being a second failure on top of the first.
 *
 * What it cannot do is free a Vite that never released its own watcher and
 * sockets. Measured both ways: a close that does its work and then throws lets
 * the file report and end in six seconds, and a close that does nothing at all
 * leaves the file held by handles no caller can reach. The first shape is the
 * one that strands a browser, and it is the one this closes.
 *
 * @param {{ diagnostic: (message: string) => void }} t the test the server belongs to.
 * @param {{ close: () => Promise<unknown>, httpServer?: { closeAllConnections?: () => void } }} server
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>} once the server has closed or its bound has passed.
 */
export async function endViteServer(t, server, options = {}) {
  const budget = options.timeoutMs ?? VITE_CLOSE_BUDGET_MS;
  let timer;
  const late = Symbol('late');
  try {
    const closed = Promise.resolve(server.close()).then(() => null, error => error);
    server.httpServer?.closeAllConnections?.();
    const outcome = await Promise.race([
      closed,
      new Promise(resolve => { timer = setTimeout(() => resolve(late), budget); }),
    ]);
    if (outcome === late) t.diagnostic(`the Vite server did not close within ${budget} ms, and the suite went on without it`);
    else if (outcome !== null) t.diagnostic(`the Vite server did not close cleanly: ${outcome}`);
  } catch (error) {
    t.diagnostic(`the Vite server could not be asked to close: ${error}`);
  } finally {
    clearTimeout(timer);
  }
}
