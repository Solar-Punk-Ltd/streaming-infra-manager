/**
 * Why a browser suite that fails can hang until the runner kills it.
 *
 * On 2026-09-11 `versions-layout.test.mjs` failed one case with a Chrome
 * protocol timeout, reported its cases, and then never exited.
 * `frontend/test/run-all.mjs` killed it with its process group after the 600
 * second per-file bound. One failing suite cost the run ten minutes, which on
 * the runner is ten billed minutes.
 *
 * The cause is the shape of the teardown rather than anything about Vite. Node
 * runs a test's `after` hooks in registration order and stops at the first one
 * that throws. The five suites that own a Vite server directly register its
 * teardown before `launchChrome` registers Chrome's, so anything that goes
 * wrong closing Vite leaves a detached browser running and the file pinned.
 * The first case below is that property, measured in a child process rather
 * than argued. The rest are what `endViteServer` answers with instead.
 *
 * A Node-only file apart from one real Vite server over a throwaway root. No
 * browser.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

import { endViteServer } from './teardown.mjs';

/** Long enough for a close that is going to finish, short enough that a hang is not this suite's cost. */
const BOUND_MS = 2000;

/** Collects what each hook did, so the child can say which of them ran. */
const TWO_HOOKS = `
  const test = require('node:test');
  test('two teardowns, the first of them broken', (t) => {
    t.after(() => { console.log('ran first'); throw new Error('the first hook failed'); });
    t.after(() => { console.log('ran second'); });
  });
`;

test('a teardown that throws leaves every teardown behind it undone', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vite-teardown-hooks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'hooks.test.cjs');
  await writeFile(file, TWO_HOOKS);
  // Without clearing this the child sees itself as part of this run and
  // refuses to run any file, which looks exactly like a child that said nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', file], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  // Not 'exit': the child can be gone with its output still on its way here.
  await once(child, 'close');

  assert.match(output, /ran first/, `the first hook ran, saw ${JSON.stringify(output.slice(0, 300))}`);
  assert.doesNotMatch(output, /ran second/, 'and the hook registered after it never did, which is what strands a browser');
});

/** A Vite over an empty root with one endless response, which is the shape of the fixtures' `/events`. */
async function serverOverAThrowawayRoot() {
  const root = await mkdtemp(join(tmpdir(), 'vite-teardown-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>teardown</title>');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'endless-response',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/events') return next();
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': open\n\n');
        });
      },
    }],
  });
  await server.listen();
  return { server, root, origin: `http://127.0.0.1:${server.httpServer.address().port}` };
}

/** One request that stays open, the way a page's EventSource does. */
function openEndlessRequest(origin) {
  const request = get(`${origin}/events`);
  return once(request, 'response').then(() => request);
}

/** Whether a promise settled inside the bound, leaving no timer behind either way. */
async function settlesWithin(work, ms) {
  let timer;
  const late = Symbol('late');
  const outcome = await Promise.race([
    work.then(() => 'settled', () => 'settled'),
    new Promise(resolve => { timer = setTimeout(() => resolve(late), ms); }),
  ]);
  clearTimeout(timer);
  return outcome === 'settled';
}

/** A test context that records its diagnostics instead of printing them. */
function recorder() {
  const said = [];
  return { said, diagnostic: (message) => said.push(message) };
}

test('endViteServer closes a real server, and nothing reaches it afterwards', async (t) => {
  const { server, root, origin } = await serverOverAThrowawayRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const held = await openEndlessRequest(origin);
  const said = recorder();

  assert.equal(await settlesWithin(endViteServer(said, server), BOUND_MS), true, 'the server closed with a connection open');

  assert.deepEqual(said.said, [], 'a clean close says nothing');
  held.destroy();
  await assert.rejects(openEndlessRequest(origin), 'the port is not answering any more');
});

test('endViteServer answers within its bound when a close never finishes', async () => {
  const never = { close: () => new Promise(() => undefined), httpServer: { closeAllConnections: () => undefined } };
  const said = recorder();

  assert.equal(await settlesWithin(endViteServer(said, never, { timeoutMs: 50 }), BOUND_MS), true);

  assert.match(said.said[0] ?? '', /did not close within 50 ms/, 'and the log says the suite went on without it');
});

test('endViteServer reports a close that fails instead of throwing it at the hooks behind it', async () => {
  const broken = { close: () => Promise.reject(new Error('the watcher would not stop')), httpServer: {} };
  const said = recorder();

  await endViteServer(said, broken);

  assert.match(said.said[0] ?? '', /the watcher would not stop/);
});

test('endViteServer survives a server that cannot even be asked', async () => {
  const said = recorder();

  await endViteServer(said, { close: () => { throw new Error('already gone'); } });

  assert.match(said.said[0] ?? '', /could not be asked to close.*already gone/);
});
