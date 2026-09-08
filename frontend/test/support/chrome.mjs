import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(read, accepts = Boolean, description = 'condition') {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Runs an isolated Chrome profile. Only this process and its profile are cleaned up. */
export async function launchChrome(t, origin) {
  const executable = process.env.CHROME_BIN ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executable);
  const profile = await mkdtemp(join(tmpdir(), 't18-chrome-'));
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
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });
  const portFile = join(profile, 'DevToolsActivePort');
  const port = await waitFor(async () => {
    try { return Number((await readFile(portFile, 'utf8')).split('\n')[0]); }
    catch { return null; }
  }, Boolean, 'Chrome debugging port');
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  const blockedRequests = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      if (new URL(request.url).origin !== origin) {
        blockedRequests.push(request.url);
        void call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } else void call('Fetch.continueRequest', { requestId });
    }
  });
  function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
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
  return { call, evaluate, errors, blockedRequests, pid: child.pid, debuggingPort: port };
}
