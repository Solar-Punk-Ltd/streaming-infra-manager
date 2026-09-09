import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(read, accepts = Boolean, description = 'condition', timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
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

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnedChild(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (hasExited(child)) return;
    const wait = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
    child.kill(signal);
    try { await wait; return; }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  if (!hasExited(child)) throw new Error(`Owned Chrome process ${child.pid} did not exit`);
}

/** Runs an isolated Chrome profile. Only this process and its profile are cleaned up. */
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
  ], { stdio: 'ignore' });
  let socket;
  t.after(async () => {
    socket?.close();
    await stopOwnedChild(child);
    await rm(profile, { recursive: true, force: true });
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
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const version = await call('Browser.getVersion');
  return {
    call, evaluate, errors, blockedRequests,
    pid: child.pid, profile, debuggingPort: port, version: version.product,
  };
}
