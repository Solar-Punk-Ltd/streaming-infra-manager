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
 * The page's own text, and '' where a document has no body yet.
 *
 * `document.body` is null from the moment a navigation commits until the
 * parser reaches the body element, and a read that lands in that window
 * throws `Cannot read properties of null` rather than answering. That is one
 * evaluate in a wait that would otherwise have polled again, and it failed
 * the third browser job on the runner.
 */
export const PAGE_TEXT = "(document.body?.innerText ?? '')";

/** An expression answering whether the page shows `text` right now. */
export function pageShows(text) {
  return `${PAGE_TEXT}.includes(${JSON.stringify(text)})`;
}

/** An expression answering the button whose own text is `text`, or undefined. */
export function buttonWithText(text) {
  return `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})`;
}

/**
 * Clicks what `finder` answers, the moment it answers an enabled element.
 *
 * A wait that asks whether a control is there followed by an evaluate that
 * clicks it are two reads of a page that renders in between, and the slower
 * the machine the wider that gap is: the element found by the first can be
 * gone by the second. One expression finds and clicks, so what was found is
 * what was clicked, and a control that never arrives times out naming itself
 * rather than throwing from inside the page.
 *
 * @param {(expression: string) => Promise<unknown>} evaluate runs an expression in the page.
 * @param {string} finder an expression answering the element, or nothing.
 * @param {string} description what this is waiting for, which is all a timeout prints.
 * @param {number} [timeoutMs]
 */
export async function clickWhenEnabled(evaluate, finder, description, timeoutMs) {
  let seen = 'nothing, the page was never read';
  const clicked = async () => {
    const state = await evaluate(`(() => {
      const element = ${finder};
      if (!element) return { found: false };
      if (element.disabled) return { found: true, enabled: false };
      element.click();
      return { found: true, enabled: true };
    })()`);
    seen = !state.found ? 'no such element on the page'
      : state.enabled ? 'the element, enabled' : 'the element, disabled';
    return state.found && state.enabled;
  };
  try {
    return await waitFor(clicked, Boolean, description, timeoutMs);
  } catch (error) {
    // Which of the two it was decides where to look, and a bare timeout says
    // neither. The runner's log is often the only evidence a failure leaves.
    throw new Error(`${error.message}. The last read saw ${seen}.`);
  }
}

/**
 * Where to click what `finder` answers, once it answers an enabled element.
 *
 * For the suites that drive a real mouse through `Input.dispatchMouseEvent`
 * rather than calling `click()`, which is the only way to exercise what a
 * pointer does to a control. The element is scrolled into view by the same
 * expression that measures it, so the point cannot be one it has moved off.
 *
 * @returns {Promise<{ x: number, y: number }>} the middle of that element.
 */
export function pointToClick(evaluate, finder, description, timeoutMs) {
  return waitFor(() => evaluate(`(() => {
    const element = ${finder};
    if (!element || element.disabled) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`), Boolean, description, timeoutMs);
}

/**
 * One property of the element `finder` answers, once there is one to read.
 *
 * @param {string} property the property name, such as `value` or `innerText`.
 */
export function readWhenPresent(evaluate, finder, property, description, timeoutMs) {
  return waitFor(
    () => evaluate(`(${finder})?.${property} ?? null`),
    (value) => value !== null,
    description,
    timeoutMs,
  );
}

/**
 * Puts `value` into the field `finder` answers, once there is an enabled one.
 *
 * React reads a field's value off the element and only when it hears the
 * input event, so the native setter and that event are what typing is here.
 */
export function fillWhenPresent(evaluate, finder, value, description, timeoutMs) {
  return waitFor(() => evaluate(`(() => {
    const field = ${finder};
    if (!field || field.disabled) return false;
    const shape = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    field.focus();
    Object.getOwnPropertyDescriptor(shape, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`), Boolean, description, timeoutMs);
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

/** What one Chrome protocol request gets on an unthrottled page. */
export const PROTOCOL_TIMEOUT_MS = 10_000;

/**
 * What one protocol request gets, stretched by whatever throttle is on.
 *
 * An evaluate runs in the page, so a rate of 4 makes the same expression take
 * four times as long, and a fixed budget would end the request rather than the
 * thing it is measuring. The row measurement in versions-layout.test.mjs took
 * a whole browser run past ten seconds at rate 4 and failed as
 * `Chrome request timed out: Runtime.evaluate`, which names the plumbing and
 * not the page.
 */
export function protocolTimeoutFor(env = process.env) {
  return PROTOCOL_TIMEOUT_MS * (cpuThrottleRate(env) ?? 1);
}

export function createProtocolClient(socket, timeoutMs = PROTOCOL_TIMEOUT_MS) {
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
 * How much slower than this machine a page session runs, from `BROWSER_CPU_THROTTLE`.
 *
 * The job's runner has two cores where this laptop has twelve, and each of
 * three browser jobs in a row failed one different Chrome suite there while
 * the whole set passed here. The value is a divider, so 4 asks for a quarter
 * of this machine's speed. One and below, and anything that is not a number,
 * is no throttling at all.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null} the rate asked for, or null.
 */
export function cpuThrottleRate(env = process.env) {
  const rate = Number(env.BROWSER_CPU_THROTTLE);
  return Number.isFinite(rate) && rate > 1 ? rate : null;
}

/**
 * Slows one page session to `cpuThrottleRate`.
 *
 * Every session the suites open goes through here, second tabs included: the
 * rate is set on a page target rather than on the browser, so a tab that
 * opened a session of its own runs at full speed until it is told otherwise.
 *
 * @param {(method: string, params?: object) => Promise<unknown>} call that session's protocol client.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<number | null>} the rate applied, or null when none was.
 */
export async function throttleCpu(call, env = process.env) {
  const rate = cpuThrottleRate(env);
  if (rate !== null) await call('Emulation.setCPUThrottlingRate', { rate });
  return rate;
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
  const { call } = createProtocolClient(socket, protocolTimeoutFor());
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
  const throttled = await throttleCpu(call);
  const version = await call('Browser.getVersion');
  const slowedBy = throttled === null ? '' : `, CPU throttled ${throttled}x`;
  t.diagnostic(`${version.product} at ${executable}, debugging port ${port}${slowedBy}`);
  return {
    call, evaluate, errors, blockedRequests,
    pid: child.pid, profile, debuggingPort: port, version: version.product,
  };
}
