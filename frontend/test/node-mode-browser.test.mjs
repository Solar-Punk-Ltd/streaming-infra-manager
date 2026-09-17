/**
 * Choosing a Bee node's mode and its chain endpoint, all the way through.
 *
 * A real headless Chrome over a real Vite, proxying to a real dev mock
 * manager, so the wizard's body is read by something that applies the same
 * rules a host would. Runs with the other suites here under
 * `pnpm test:browser`, or on its own:
 * `node --import tsx --test frontend/test/node-mode-browser.test.mjs`.
 *
 * Levi ruled on 2026-09-17 (T27) that both are chosen when the node is created
 * and that the node's page shows them. This walks it: a viewer gateway in each
 * mode, a stream on the manager's own endpoint, and the two entries read off
 * each page afterwards. What it is here to catch is the gap the wizard and the
 * page can drift into, where a choice is made on one screen and a different
 * one is reported on the next.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  waitFor,
} from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/**
 * A wizard step can sit behind a Vite dependency re-optimization the first
 * time a cold cache meets it, which on a busy machine takes a Continue button
 * past the default fifteen seconds. The budget is only ever spent while the
 * button is missing, so a fast run pays nothing for it.
 */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** The stack version the mock seeds as its default, which is its first. */
const DEFAULT_VERSION = '1';

async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** The dev mock manager, on a port of its own, as its own process. */
async function startMockManager(t) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx', '--conditions=development', '--input-type=module',
      '-e', "await import('./dev/mock-manager.mjs'); process.send({ ready: true });",
    ],
    { cwd: frontend, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const bound = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(bound); }
  });
  await new Promise((done, fail) => {
    const bound = setTimeout(() => finish(new Error('the mock manager did not start')), 20_000);
    const onMessage = (message) => { if (message?.ready) finish(); };
    const onExit = () => finish(new Error('the mock manager exited before it was ready'));
    const finish = (error) => {
      clearTimeout(bound);
      child.off('message', onMessage);
      child.off('exit', onExit);
      error ? fail(error) : done();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  return `http://127.0.0.1:${port}`;
}

test('a node is created in the mode and on the endpoint the wizard offered', async (t) => {
  const manager = await startMockManager(t);
  // Read by vite.config.ts when the config module loads, which is inside
  // createServer below, so the proxy in front of this Vite is the one the app
  // uses in development. Nothing here stands in for the manager.
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('node-mode'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const found = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const click = async (text, timeoutMs = COLD_OPTIMIZE_BUDGET_MS) => {
    await clickWhenEnabled(evaluate, buttonWithText(text), `an enabled ${text} button`, timeoutMs);
    await settled();
  };
  const clickSelected = async (selector, description) => {
    await clickWhenEnabled(evaluate, found(selector), description);
    await settled();
  };
  const fill = (selector, value) =>
    fillWhenPresent(evaluate, found(selector), value, `the ${selector} field`);
  /** One radio card of a ChoiceGroup, which carries its title as its label. */
  const choose = async (label) => {
    await clickSelected(`input[type=radio][aria-label=${JSON.stringify(label)}]`, `the ${label} choice`);
  };
  const chosen = (label) =>
    evaluate(`${found(`input[type=radio][aria-label=${JSON.stringify(label)}]`)}?.checked ?? null`);
  const next = async () => { await click('Continue'); await settled(); };
  /**
   * The version picker is offered whenever the choice is not already made for
   * the operator, and whether this run gets that is a race with the versions
   * request, so every Continue out of Basics goes through here.
   */
  const continueFromBasics = async () => {
    const offered = await evaluate(`(() => {
      const field = ${found('#wizard-version')};
      if (!field) return false;
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      return true;
    })()`);
    if (offered) await clickSelected(`[role="option"][data-value="${DEFAULT_VERSION}"]`, 'the seeded default version');
    await next();
  };

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fill('input[name=username]', DEV_USERNAME);
  await fill('input[name=password]', DEV_PASSWORD);
  await click('Sign in');
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot');

  /** The wizard from the goal card to the deployment page it lands on. */
  const create = async (goal, name, settings) => {
    await click('New deployment');
    await clickSelected(`input[type=radio][aria-label=${JSON.stringify(goal)}]`, `the ${goal} goal`);
    await next();
    await fill('input[placeholder="main-stage"], input[placeholder="viewer-eu"]', name);
    await continueFromBasics();
    await settings();
    await next();
    const review = await body();
    await click('Deploy');
    await waitFor(body, (text) => text.includes(name) && text.includes('Configuration'), `the ${name} page`);
    return review;
  };

  const ultraLight = await create('Watch a stream', 'gateway-offline', async () => {
    await waitFor(body, (text) => text.includes('Node mode'), 'the node mode question');
    assert.equal(await chosen('Ultra-light'), true, 'a viewer gateway starts on the mode that costs nothing');
    assert.equal(
      await evaluate(`${found('input[type=radio][aria-label="Manager\\'s endpoint"]')} !== null`),
      false,
      'an ultra-light node reaches no chain, so it is asked about none',
    );
  });
  assert.match(ultraLight, /Ultra-light, download only/);
  const ultraLightPage = await body();
  assert.match(ultraLightPage, /Ultra-light, download only/);
  assert.match(ultraLightPage, /None, an ultra-light node reaches no chain/);

  const light = await create('Watch a stream', 'gateway-on-chain', async () => {
    await choose('Light');
    await waitFor(
      () => chosen("Manager's endpoint"),
      (state) => state === true,
      'the manager own endpoint, offered first',
    );
    // The stack gives its gateway an empty endpoint, which is what makes that
    // node ultra-light, so a light one cannot take that default.
    assert.equal(await evaluate(`${found('input[type=radio][aria-label="Stack default"]')}?.disabled ?? null`), true);
  });
  assert.match(light, /Light, publishes/);
  assert.match(light, /Manager's endpoint/);
  const lightPage = await body();
  assert.match(lightPage, /Light, publishes/);
  assert.match(lightPage, /Manager's endpoint \(/);

  const stream = await create('Stream to Swarm', 'stage-on-chain', async () => {
    await waitFor(body, (text) => text.includes('Light node, required to publish'), 'the stated mode');
    assert.equal(await chosen('Ultra-light'), null, 'a publishing node is told, not asked');
    assert.equal(await chosen("Manager's endpoint"), true);
  });
  assert.match(stream, /Light, publishes/);
  const streamPage = await body();
  assert.match(streamPage, /Light, publishes/);
  assert.match(streamPage, /Manager's endpoint \(/);

  // What the manager actually stored, rather than what the page rendered.
  const stored = await evaluate(`fetch('/profiles').then(r => r.json()).then(body => body.profiles
    .filter(profile => ['gateway-offline', 'gateway-on-chain', 'stage-on-chain'].includes(profile.name))
    .map(profile => [profile.name, profile.node_mode, profile.rpc_endpoint_source, profile.rpc_endpoint]))`);
  assert.deepEqual(stored.sort(), [
    ['gateway-offline', 'ultra-light', 'stack', null],
    ['gateway-on-chain', 'light', 'manager', null],
    ['stage-on-chain', null, 'manager', null],
  ]);
  assert.deepEqual(browser.errors, []);
});
