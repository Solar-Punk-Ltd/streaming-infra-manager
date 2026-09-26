/**
 * A new deployment created fully configured from the wizard, in a real Chrome,
 * at a phone's width.
 *
 * Levi ruled on 2026-09-25 that every setting a deployment reads is editable,
 * with the version's value as the default, and the plan's item C.5 puts the
 * deployment page's settings editor into the new-deployment wizard, so a
 * deployment is created with its settings already set. This walks it: the
 * Advanced settings fold on the settings step, folded until opened, the list
 * the manager answers for the version and the services chosen, a changed key,
 * a value the manager would refuse stopping Continue, a secret that is never
 * shown, the segment length shown on the key it decides, a key typed under
 * one engine kept aside under another, the review naming the keys, and the
 * deployment's own page listing them as its own once it is made.
 *
 * A real headless Chrome over a real Vite, proxying to the real dev mock
 * manager, whose create checks the settings by the manager's own rules. Runs
 * with the other suites under `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/wizard-settings-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  readWhenPresent,
  waitFor,
} from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A cold Vite cache can hold a wizard step behind a dependency re-optimization, and this is only spent while waiting. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const NARROW = 390;

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** main-v3 in the mock, whose contract names generated secrets. */
const VERSION = '2';

const NAME = 'wizard-configured';

/** Synthetic, and never expected on any page once typed. */
const TOKEN = 'offline-wizard-admin-token-0123456789abcdef';
const WEBHOOK_TOKEN = 'offline-wizard-webhook-token-0123456789';

async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** The dev mock manager on a port of its own, with the seeded blocked attempt released so creates deploy. */
async function startMockManager(t) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx', '--conditions=development', '--input-type=module',
      '-e', "import { state } from './dev/mock-seed.mjs'; await import('./dev/mock-manager.mjs'); state.attempts = []; process.send({ ready: true });",
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

test('the wizard creates a deployment with its own settings at a phone width', { timeout: 300_000 }, async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('wizard-settings'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const evidence = await evidenceDirectory('wizard-settings-browser-');
  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (finder, description, timeoutMs = COLD_OPTIMIZE_BUDGET_MS) => {
    await clickWhenEnabled(evaluate, finder, description, timeoutMs);
    await settled();
  };
  const found = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const dialog = `document.querySelector('.MuiDialog-paper')`;
  const footer = () => evaluate(`document.querySelector('.MuiDialogActions-root')?.innerText ?? ''`);
  const foldButton = `[...document.querySelectorAll('button[aria-expanded]')].find(button => button.textContent.includes('Advanced settings'))`;
  const fold = `document.getElementById((${foldButton})?.getAttribute('aria-controls') ?? '')`;
  const foldText = () => evaluate(`(${foldButton})?.closest('section')?.innerText ?? ''`);
  const rowOf = (key) => `document.querySelector('li[data-setting="${key}"]')`;
  const fieldOf = (key) => `document.querySelector('[aria-label="${key}"]')`;
  const rowText = (key) => readWhenPresent(evaluate, rowOf(key), 'innerText', `the ${key} row`);
  const search = (text) => fillWhenPresent(evaluate, `${dialog}?.querySelector('input[aria-label="Search settings"]')`, text, 'the search field');
  const choose = (key, value) => waitFor(() => evaluate(`(() => {
    const field = ${fieldOf(key)};
    if (!field || field.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`), Boolean, `the ${key} list`);
  const engine = (label) => click(found(`input[type=radio][aria-label=${JSON.stringify(label)}]`), `the ${label} engine`);
  const continueDisabled = () => readWhenPresent(evaluate, buttonWithText('Continue'), 'disabled', 'the Continue button');
  // The viewport alone, as the deployment settings suite takes it.
  const screenshot = async (name) => {
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(join(evidence, name), Buffer.from(data, 'base64'));
  };

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fillWhenPresent(evaluate, found('input[name=username]'), DEV_USERNAME, 'the username field');
  await fillWhenPresent(evaluate, found('input[name=password]'), DEV_PASSWORD, 'the password field');
  await click(buttonWithText('Sign in'), 'the Sign in button');
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot', COLD_OPTIMIZE_BUDGET_MS);

  await t.test('the settings step ends with Advanced settings, folded until opened', async () => {
    await click(buttonWithText('New deployment'), 'the New deployment button');
    await click(
      `[...document.querySelectorAll('[role=radio]')].find(node => node.textContent.trim().startsWith('Stream to Swarm'))`,
      'the Stream to Swarm goal',
    );
    await click(buttonWithText('Continue'), 'the Continue button');
    await fillWhenPresent(evaluate, found('input[placeholder="main-stage"]'), NAME, 'the name field', COLD_OPTIMIZE_BUDGET_MS);
    await evaluate(`${found('#wizard-version')}?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
    await click(found(`[role="option"][data-value="${VERSION}"]`), 'main-v3 in the version list');
    await click(buttonWithText('Continue'), 'the Continue button');

    await waitFor(foldText, (text) => text.includes('Every key this version declares'), 'the Advanced settings fold');
    assert.equal(await evaluate(`(${foldButton}).getAttribute('aria-expanded')`), 'false');
    assert.equal(await evaluate(`Boolean(${fold})`), false, 'a folded fold renders no key');
  });

  await t.test('opened, it lists the version keys folded by section, with a search over them', async () => {
    await click(foldButton, 'the Advanced settings fold');
    await waitFor(() => evaluate(`Boolean(${fold}?.querySelector('input[aria-label="Search settings"]'))`), Boolean, 'the list');
    await waitFor(() => evaluate(`Boolean((${foldButton})?.closest('section')?.querySelector('.MuiCollapse-entered'))`), Boolean, 'the fold fully open');
    const text = await foldText();
    assert.match(text, /Each key shows the version's value as its default\./);
    assert.match(text, /Stream Uploader\s+\d+ settings/);
    assert.match(text, /SRS Media Server\s+3 settings/);
    assert.equal(await evaluate(`${fold}.querySelectorAll('li[data-setting]').length`), 0, 'every section starts folded');
    await evaluate(`(${foldButton}).scrollIntoView({ block: 'start' })`);
    await screenshot('folded-sections-phone.png');
  });

  await t.test('a changed key is marked changed, and nothing to recreate', async () => {
    await search('LOG_LEVEL');
    await choose('LOG_LEVEL', 'debug');
    await waitFor(() => rowText('LOG_LEVEL'), (text) => text.includes('changed'), 'the changed marker');
    const row = await rowText('LOG_LEVEL');
    assert.match(row, /Default: info/);
    assert.doesNotMatch(row, /recreates|full redeploy|unsaved/);
    await waitFor(foldText, (text) => text.includes('1 setting changed'), 'the count on the fold');
  });

  await t.test('a value the manager would refuse is named under its field and stops Continue', async () => {
    await search('MAX_QUEUE_SIZE');
    await fillWhenPresent(evaluate, fieldOf('MAX_QUEUE_SIZE'), '0', 'the queue size field');
    await waitFor(() => rowText('MAX_QUEUE_SIZE'), (text) => text.includes('MAX_QUEUE_SIZE must be at least 1. Got 0.'), 'the refusal under the field');
    await waitFor(continueDisabled, (off) => off === true, 'a Continue that stops at the refused value');
    assert.match(await footer(), /Advanced settings: One value cannot be used as written: MAX_QUEUE_SIZE/);
    await screenshot('refused-value-phone.png');

    await fillWhenPresent(evaluate, fieldOf('MAX_QUEUE_SIZE'), '250', 'the queue size field');
    await waitFor(continueDisabled, (off) => off === false, 'Continue back on');
  });

  await t.test('a secret is a masked field that starts empty, and a generated one says it is made at the first deploy', async () => {
    await search('TOKEN');
    await waitFor(() => evaluate(`Boolean(${fieldOf('ADMIN_API_TOKEN')})`), Boolean, 'the admin token field');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.type`), 'password');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.value`), '');
    assert.match(await rowText('API_AUTH_TOKEN'), /The manager generates a value for this deployment when it first deploys\./);
    await fillWhenPresent(evaluate, fieldOf('ADMIN_API_TOKEN'), TOKEN, 'the admin token field');
    await waitFor(() => rowText('ADMIN_API_TOKEN'), (text) => text.includes('changed'), 'the typed token marked changed');
    assert.equal((await body()).includes(TOKEN), false, 'a typed secret is never shown as text');
  });

  await t.test('HLS_FRAGMENT shows the segment length above it and takes no input', async () => {
    await search('HLS_FRAGMENT');
    await waitFor(() => rowText('HLS_FRAGMENT'), (text) => text.includes('Decided by the engine settings'), 'the owned row');
    assert.equal(await evaluate(`${rowOf('HLS_FRAGMENT')}.querySelectorAll('input, select, textarea').length`), 0);
    const segment = await evaluate(`${found('#wizard-segment-length')}.value`);
    assert.match(await rowText('HLS_FRAGMENT'), new RegExp(`^HLS_FRAGMENT[\\s\\S]*\\n${segment.replace('.', '\\.')}\\n`));

    await fillWhenPresent(evaluate, found('#wizard-segment-length'), '1.5', 'the segment length field');
    await waitFor(() => rowText('HLS_FRAGMENT'), (text) => /\n1\.5\n/.test(text), 'the owned row following the segment length');
  });

  await t.test('a key typed under one engine is kept aside, not sent, under another', async () => {
    await search('SRS_WEBHOOK_TOKEN');
    await fillWhenPresent(evaluate, fieldOf('SRS_WEBHOOK_TOKEN'), WEBHOOK_TOKEN, 'the webhook token field');
    await waitFor(foldText, (text) => text.includes('4 settings changed'), 'four changed keys');

    await engine('OvenMediaEngine');
    await waitFor(
      foldText,
      (text) => text.includes('Not sent, because this version does not take it with these choices: SRS_WEBHOOK_TOKEN.'),
      'the kept-aside note under OvenMediaEngine',
    );
    await waitFor(foldText, (text) => text.includes('3 settings changed'), 'three keys sent under OvenMediaEngine');

    await engine('SRS');
    await waitFor(foldText, (text) => text.includes('4 settings changed') && !text.includes('Not sent'), 'the webhook token back under SRS');
  });

  await t.test('the open fold fits a phone with no sideways scroll, every section at the height of its keys', async () => {
    await search('');
    await evaluate(`[...${fold}.querySelectorAll('h4 button')].filter(button => button.getAttribute('aria-expanded') === 'false').forEach(button => button.click())`);
    await waitFor(() => evaluate(`${fold}.querySelectorAll('li[data-setting]').length`), (count) => count > 20, 'every key on screen');
    // A section grows to its keys over a short animation. One that stays
    // shorter than its keys is drawn under the next heading, which no text
    // read can see, so this waits for every one to settle at its keys.
    await waitFor(
      () => evaluate(`[...${fold}.querySelectorAll('.MuiCollapse-root')].map(section => ({
        section: Math.round(section.getBoundingClientRect().height),
        keys: Math.round(section.querySelector('ul')?.getBoundingClientRect().height ?? 0),
      }))`),
      (sections) => sections.length === 7 && sections.every(({ section, keys }) => keys > 0 && section >= keys - 1),
      'every section at the height of its keys',
    );
    const measurement = await evaluate(`(() => {
      const paper = ${dialog};
      const content = paper.querySelector('.MuiDialogContent-root');
      return {
        page: document.documentElement.scrollWidth,
        sideways: Math.max(paper.scrollWidth - paper.clientWidth, content.scrollWidth - content.clientWidth),
        outside: [...${fold}.querySelectorAll('input, select, button')]
          .filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); })
          .map(el => el.getAttribute('aria-label') ?? el.textContent.trim()),
      };
    })()`);
    assert.ok(measurement.page <= NARROW, `page width ${measurement.page} exceeds ${NARROW}`);
    assert.equal(measurement.sideways, 0, 'the dialog scrolls sideways');
    assert.deepEqual(measurement.outside, []);
    await evaluate(`(${foldButton}).scrollIntoView({ block: 'start' })`);
    await screenshot('open-fold-phone.png');
  });

  await t.test('the review names the keys the create sets and never a value', async () => {
    await click(buttonWithText('Continue'), 'the Continue button');
    await waitFor(body, (text) => text.includes('Check it, then deploy.'), 'the review');
    const review = await body();
    // In the list's order, which puts the admin section first.
    assert.match(review, /Advanced settings\s+ADMIN_API_TOKEN, MAX_QUEUE_SIZE, LOG_LEVEL and SRS_WEBHOOK_TOKEN set for this deployment\. Every other key keeps the version's value\./);
    assert.equal(review.includes(TOKEN) || review.includes(WEBHOOK_TOKEN), false);
    await screenshot('review-phone.png');
  });

  await t.test('the deployment it creates lists those values as its own', async () => {
    await click(buttonWithText('Deploy'), 'the Deploy button');
    await waitFor(body, (text) => text.includes(NAME) && text.includes('Stack settings'), `the ${NAME} page with its settings card`);
    const card = `document.getElementById('stack-settings')`;
    await fillWhenPresent(evaluate, `${card}?.querySelector('input[aria-label="Search settings"]')`, 'LOG_LEVEL', 'the card search');
    await waitFor(() => rowText('LOG_LEVEL'), (text) => text.includes('set here'), 'the created value as the deployment own');
    assert.equal(await evaluate(`${fieldOf('LOG_LEVEL')}.value`), 'debug');

    await fillWhenPresent(evaluate, `${card}?.querySelector('input[aria-label="Search settings"]')`, 'ADMIN_API_TOKEN', 'the card search');
    await waitFor(() => rowText('ADMIN_API_TOKEN'), (text) => text.includes('A value is stored for this deployment. It is never shown.'), 'the stored token');

    const stored = await evaluate(`fetch('/profiles/${NAME}/settings').then(r => r.json()).then(list => list.entries
      .filter(entry => entry.stored).map(entry => [entry.key, entry.storedValue]))`);
    // The segment length the wizard's own engine step took is listed too: a
    // deployment's list takes its engine settings as its own since the Engine
    // card's drawer went on 2026-09-26.
    assert.deepEqual(stored, [
      ['ADMIN_API_TOKEN', null],
      ['MAX_QUEUE_SIZE', '250'],
      ['LOG_LEVEL', 'debug'],
      ['HLS_FRAGMENT', '1.5'],
      ['SRS_WEBHOOK_TOKEN', null],
    ]);
    const page = await body();
    assert.equal(page.includes(TOKEN) || page.includes(WEBHOOK_TOKEN), false);
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  t.diagnostic(`screenshots in ${evidence}`);
});
