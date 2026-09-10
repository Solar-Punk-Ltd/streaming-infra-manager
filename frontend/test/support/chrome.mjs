import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Polls `read` until `accepts` takes what it answered, or the budget runs out.
 *
 * The description is not optional, because it is the whole of what a timeout
 * says. Without one a failed wait reads "Timed out waiting for condition",
 * which in a browser suite of hundreds of waits names nothing at all, and the
 * log of a run on a runner is usually the only evidence there is.
 */
export async function waitFor(read, accepts = Boolean, description = '', timeoutMs = 15_000) {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error('A wait says what it is waiting for, since that is all a timeout here prints.');
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Counts the requests a page completes from this call on, by the end of their URL.
 *
 * A `PerformanceObserver` is handed every resource entry whatever the timing
 * list holds, which is the whole reason to use one:
 * `performance.getEntriesByType('resource')` answers from a capped list that a
 * Vite page fills with its own modules during boot, so the request a wait is
 * watching for is usually missing from it. Counting from the call rather than
 * over the document also names one request, so a wait cannot be satisfied by a
 * response that arrived before the thing it is waiting for was even asked for.
 *
 * A reload ends the count, since the document that was doing the counting is
 * gone. Take a new one after a reload.
 *
 * @param {(expression: string) => Promise<unknown>} evaluate runs an expression in the page.
 * @param {string} suffix the end of the URLs to count, such as `/groups`.
 * @returns {Promise<() => Promise<number>>} how many have completed since this call.
 */
export async function watchCompletedRequests(evaluate, suffix) {
  const watched = JSON.stringify(suffix);
  await evaluate(`(() => {
    const counts = window.completedRequestCounts ??= new Map();
    if (!window.completedRequestObserver) {
      window.completedRequestObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          for (const [suffix, count] of counts) if (entry.name.endsWith(suffix)) counts.set(suffix, count + 1);
        }
      });
      window.completedRequestObserver.observe({ type: 'resource' });
    }
    counts.set(${watched}, 0);
  })()`);
  return () => evaluate(`(() => {
    const counts = window.completedRequestCounts;
    if (!counts?.has(${watched})) throw new Error('Nothing in this document is counting requests ending ' + ${watched} + '. A reload ends a count.');
    return counts.get(${watched});
  })()`);
}

export function createProtocolClient(socket, timeoutMs = 10_000) {
  let nextId = 0;
  let ended = false;
  const pending = new Map();
  function finish(id, result, error) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  }
  function connectionEnded() {
    ended = true;
    for (const id of pending.keys()) finish(id, null, new Error('Chrome connection ended'));
  }
  socket.addEventListener('close', connectionEnded);
  socket.addEventListener('error', connectionEnded);
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) finish(message.id, message.result, message.error ? new Error(message.error.message) : null);
  });
  return {
    call(method, params = {}) {
      if (ended) return Promise.reject(new Error('Chrome connection ended'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(id, null, new Error(`Chrome request timed out: ${method}`)), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { finish(id, null, new Error('Chrome request could not be sent')); }
      });
    },
  };
}

/**
 * How many completed requests a document remembers for `performance.getEntriesByType('resource')`.
 *
 * That list holds the first entries of a document and nothing once it is full.
 * Vite serves every module as a request of its own, so a page here fills the
 * default 250 during its own boot and never records the request a test is
 * waiting for. Keeping it small makes that true on this laptop as well, so a
 * wait that reads the list fails here rather than only on a loaded runner.
 * Waits count completed requests through `watchCompletedRequests` instead,
 * which a PerformanceObserver answers whatever this list holds.
 */
const RESOURCE_TIMING_BUFFER = 10;

/** How long a signalled Chrome gets before the next signal, and before the teardown refuses. */
const EXIT_WAIT_MS = 3000;
/** How long the helpers get to stop writing into the profile before it is left where it is. */
const PROFILE_REMOVAL_BUDGET_MS = 10_000;
const PROFILE_REMOVAL_STEP_MS = 250;
/** What a removal is told while something is still writing into the profile, rather than for good. */
const STILL_BUSY = new Set(['ENOTEMPTY', 'EBUSY', 'ENOTDIR']);

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Signals the child's whole process group, and the child alone where that is refused.
 *
 * Chrome is started detached below, so the group id is its pid and the negative
 * pid reaches chrome_crashpad_handler and the renderers as well. Those are not
 * the process `spawn` returned, and they are what a plain `child.kill` misses.
 */
function signalTree(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

/**
 * Ends an owned Chrome and every process it started.
 *
 * The last signal goes out after the main process has exited, because that is
 * exactly when the helpers are still there: on Linux they outlive it by a
 * moment, and on the runner they outlived the whole job.
 */
async function stopChromeTree(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (hasExited(child)) break;
    const wait = once(child, 'exit', { signal: AbortSignal.timeout(EXIT_WAIT_MS) });
    signalTree(child, signal);
    try { await wait; break; }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  if (!hasExited(child)) throw new Error(`Owned Chrome process ${child.pid} did not exit`);
  signalTree(child, 'SIGKILL');
}

/**
 * Removes a Chrome profile, waiting out whatever is still writing into it.
 *
 * @param {string} profile the directory to remove.
 * @param {{ remove?: typeof rm, budgetMs?: number, stepMs?: number }} [options]
 * @returns {Promise<Error | null>} what stopped it, for the caller to report, or null.
 */
export async function removeProfile(profile, options = {}) {
  const { remove = rm, budgetMs = PROFILE_REMOVAL_BUDGET_MS, stepMs = PROFILE_REMOVAL_STEP_MS } = options;
  const until = Date.now() + budgetMs;
  for (;;) {
    try {
      await remove(profile, { recursive: true, force: true });
      return null;
    } catch (error) {
      if (!STILL_BUSY.has(error.code) || Date.now() >= until) return error;
      await delay(stepMs);
    }
  }
}

/**
 * Ends an owned Chrome, its helpers and its profile.
 *
 * A profile that will not go is reported through `reporter.diagnostic` and
 * never thrown. It is a temporary directory left behind, which is housekeeping
 * for whoever cleans the machine, and the suite that just passed is not the
 * thing that is wrong with it. A Chrome that will not exit is thrown, because
 * that one outlives the job.
 */
export async function endChromeSession(reporter, child, profile, removal = {}) {
  let failure = null;
  try { await stopChromeTree(child); }
  catch (error) { failure = error; }
  const leftover = await removeProfile(profile, removal);
  if (leftover) reporter.diagnostic(`Left the Chrome profile ${profile} behind: ${leftover.message}`);
  if (failure) throw failure;
}

/**
 * Runs an isolated Chrome profile. Only the process group this starts and the
 * profile it was given are cleaned up.
 */
export async function launchChrome(t, origin) {
  const executable = process.env.CHROME_BIN ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executable);
  const profile = await mkdtemp(join(tmpdir(), 't15-chrome-'));
  const child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', detached: true });
  let socket;
  t.after(async () => {
    socket?.close();
    await endChromeSession(t, child, profile);
  });
  const portFile = join(profile, 'DevToolsActivePort');
  const port = await waitFor(async () => {
    try { return Number((await readFile(portFile, 'utf8')).split('\n')[0]); }
    catch { return null; }
  }, Boolean, 'Chrome debugging port');
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  const { call } = createProtocolClient(socket);
  const errors = [];
  const blockedRequests = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      if (new URL(request.url).origin !== origin) {
        blockedRequests.push(request.url);
        void call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      } else void call('Fetch.continueRequest', { requestId }).catch(() => undefined);
    }
  });
  async function evaluate(expression) {
    const response = await call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `performance.setResourceTimingBufferSize(${RESOURCE_TIMING_BUFFER});` });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const version = await call('Browser.getVersion');
  t.diagnostic(`${version.product} at ${executable}, debugging port ${port}`);
  return {
    call, evaluate, errors, blockedRequests,
    pid: child.pid, profile, debuggingPort: port, version: version.product,
  };
}
