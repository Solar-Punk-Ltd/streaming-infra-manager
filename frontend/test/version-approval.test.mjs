import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, waitFor } from './support/chrome.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const COMMIT = 'a'.repeat(40);
const LOST_AT = '2026-09-08T08:15:00.000Z';
const makeVersion = (overrides = {}) => ({
  id: 1, name: 'review-build', gitRef: 'main-v3', commitSha: COMMIT,
  status: 'ready', isDefault: true, tested: false, testedInvalidatedAt: LOST_AT,
  builtAt: '2026-09-08T09:00:00.000Z', lastError: null, contract: null,
  deployments: 0, layout: 'builds', buildId: `${COMMIT}-r1`, previousBuildId: COMMIT,
  ...overrides,
});

test('approval payload and explicit wizard version choice stay tied to the visible build', async (t) => {
  let versions = [makeVersion()];
  let versionsGate = null;
  let versionsRequests = 0;
  let holdEvents = false;
  let heldEvents = null;
  const writes = [];
  const server = await createServer({
    root: frontend, configFile: resolve(frontend, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{ name: 'offline-t08', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0];
        const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
        if (path === '/auth/session') return json({ username: 'offline-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
        if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
        if (path === '/profiles' && req.method === 'GET') return json({ profiles: [] });
        if (path === '/groups' && req.method === 'GET') return json({ groups: [] });
        if (path === '/versions/attempts' && req.method === 'GET') return json({ attempts: [] });
        if (path === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (holdEvents) { heldEvents = res; res.write('retry: 86400000\n\n'); }
          else res.end('retry: 86400000\n\n');
          return;
        }
        if (path === '/versions' && req.method === 'GET') {
          versionsRequests++;
          await versionsGate;
          return json(versions);
        }
        if (['POST', 'PATCH', 'DELETE'].includes(req.method) && /^(\/versions|\/profiles|\/groups)/.test(path)) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          writes.push({ path, method: req.method, body });
          if (req.method === 'PATCH' && path === '/versions/1') {
            versions[0] = { ...versions[0], tested: body.tested, testedInvalidatedAt: null };
            return json(versions[0]);
          }
          res.statusCode = 400;
          return json({ errors: ['Unexpected fixture mutation'] });
        }
        if (/^\/(auth|profiles|groups|config|events|versions|metrics|health)(\/|$)/.test(path)) {
          res.statusCode = 404;
          return json({ errors: ['Unsupported offline route'] });
        }
        next();
      });
    } }],
  });
  await server.listen();
  t.after(async () => { server.httpServer.closeAllConnections(); await server.close(); });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  async function click(expression) {
    const point = await evaluate(`(() => { const el = ${expression}; if (!el || el.disabled) throw new Error('Missing enabled control'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  const button = name => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)})`;
  let visitNumber = 0;
  async function visit(waitForVersions = true) {
    await evaluate('window.__t08OldPage = true');
    await call('Page.navigate', { url: `${origin}/?t08=${++visitNumber}#/versions` });
    if (waitForVersions) {
      await waitFor(() => evaluate(`window.__t08OldPage ? -1 : document.querySelectorAll('input[aria-label$=" tested"]').length`), n => n === versions.length);
    } else {
      await waitFor(() => evaluate(`!window.__t08OldPage && (${button('New deployment')})?.disabled === false`));
    }
  }
  async function openBasics(goal = 'Custom') {
    await click(button('New deployment'));
    await waitFor(() => evaluate('document.querySelector("[role=dialog]") !== null'));
    await click(`[...document.querySelectorAll("[role=radio]")].find(el => el.querySelector('h6')?.textContent.trim() === ${JSON.stringify(goal)})`);
    await click(button('Continue'));
    await waitFor(() => evaluate('document.querySelector("input[placeholder=main-stage]") !== null'));
    await click('document.querySelector("input[placeholder=main-stage]")');
    await call('Input.insertText', { text: 'offline-choice' });
  }
  await visit();

  await t.test('state requires an explicit choice without any default and keeps a valid choice', async () => {
    const result = await evaluate(`(async () => {
      const { initialWizardState, withGoal, versionChoiceShown, chosenVersion } = await import('/src/forms/wizard/wizardState.ts');
      const { wizardError } = await import('/src/forms/wizard/wizardError.ts');
      const { submitWizard } = await import('/src/forms/wizard/wizardSubmit.ts');
      const base = { profiles: [], groups: [], serverHost: 'offline', hostPassphrase: null, poolResults: new Map() };
      const version = ${JSON.stringify(makeVersion({ isDefault: false }))};
      const context = { ...base, versions: [version] };
      const state = { ...initialWizardState({ goal: 'custom' }, context), name: 'offline-choice' };
      let rejected = false;
      try { await submitWizard(state, context); } catch { rejected = true; }
      const explicit = { ...state, versionId: 1 };
      const switched = withGoal(explicit, 'stream', context);
      const unavailable = { ...context, versions: [{ ...version, status: 'building' }] };
      return { initial: state.versionId, shown: versionChoiceShown(context), error: wizardError(state, context), rejected,
        chosen: chosenVersion(switched, context)?.id, emptyError: wizardError(explicit, { ...base, versions: [] }),
        unavailableError: wizardError(explicit, unavailable), explicitError: wizardError(explicit, context) };
    })()`);
    assert.deepEqual(result, { initial: null, shown: true, error: 'Pick a stack version', rejected: true, chosen: 1, emptyError: 'Pick a stack version', unavailableError: 'Pick a stack version', explicitError: null });
    assert.equal(writes.length, 0, 'missing choice must never reach a deployment API');
  });

  await t.test('the sole default stays selected with the actual invalidation date visible through review', async () => {
    await visit();
    await openBasics('Stream to Swarm');
    const text = await evaluate('document.querySelector("[role=dialog]").innerText');
    const date = await evaluate(`import('/src/format.ts').then(({formatDateTime}) => formatDateTime(${JSON.stringify(LOST_AT)}))`);
    assert.ok(text.includes(`Not tested since the update on ${date}`), text);
    assert.ok(text.includes('review-build'));
    await click(button('Continue'));
    await click(button('Continue'));
    await waitFor(() => evaluate('document.querySelector("[role=dialog] [role=alert]")?.innerText'), text => text?.includes('Not tested since the update on'));
    if (process.env.T08_EVIDENCE_DIR) {
      await mkdir(process.env.T08_EVIDENCE_DIR, { recursive: true });
      const { data } = await call('Page.captureScreenshot', { fromSurface: true });
      await writeFile(resolve(process.env.T08_EVIDENCE_DIR, 'default-warning-review.png'), Buffer.from(data, 'base64'));
    }
    await click('document.querySelector("button[aria-label=close]")');
  });

  await t.test('approval transmits the shown build id and withdrawal needs no identity', async () => {
    writes.length = 0;
    await visit();
    await click('document.querySelector("input[aria-label=\\"review-build tested\\"]")');
    await waitFor(() => writes.length, n => n > 0);
    assert.deepEqual(writes.at(-1), { path: '/versions/1', method: 'PATCH', body: { tested: true, commitSha: COMMIT, buildId: `${COMMIT}-r1` } });
    await waitFor(() => evaluate('document.querySelector("input[type=checkbox]").checked'));
    await click('document.querySelector("input[aria-label=\\"review-build tested\\"]")');
    await waitFor(() => writes.length, n => n === 2);
    assert.deepEqual(writes.at(-1).body, { tested: false });
    await waitFor(() => evaluate('document.querySelector("input[type=checkbox]").checked'), checked => !checked);
    await openBasics();
    const text = await evaluate('document.querySelector("[role=dialog]").innerText');
    assert.ok(text.includes('Not currently marked as tested on this host.'));
    assert.ok(!text.includes('Not tested since the update'));
    await click('document.querySelector("button[aria-label=close]")');
  });

  await t.test('with one non-default candidate the picker waits for a choice and preserves it on back', async () => {
    versions = [makeVersion({ isDefault: false, testedInvalidatedAt: null })];
    await visit();
    await openBasics();
    assert.equal(await evaluate(`${button('Continue')}.disabled`), true);
    assert.match(await evaluate('document.querySelector("[role=dialog]").innerText'), /Pick a stack version/);
    await click('document.querySelector("#wizard-version")');
    await waitFor(() => evaluate('document.querySelector("[role=option]") !== null'));
    await click('document.querySelector("[role=option][data-value=\\"1\\"]")');
    assert.equal(await evaluate(`${button('Continue')}.disabled`), false);
    await click(button('Continue'));
    await click(button('Back'));
    assert.match(await evaluate('document.querySelector("#wizard-version").innerText'), /review-build/);
    await click('document.querySelector("button[aria-label=close]")');
  });

  await t.test('unknown immutable identity is disabled and explicit legacy approval carries null build id', async () => {
    versions = [makeVersion({ buildId: null, testedInvalidatedAt: null })];
    await visit();
    assert.equal(await evaluate('document.querySelector("input[type=checkbox]").disabled'), true);
    versions = [makeVersion({ layout: 'legacy', buildId: null, testedInvalidatedAt: null })];
    writes.length = 0;
    await visit();
    assert.equal(await evaluate('document.querySelector("input[type=checkbox]").disabled'), false);
    await click('document.querySelector("input[type=checkbox]")');
    await waitFor(() => writes.length, n => n > 0, 'legacy approval request');
    assert.deepEqual(writes[0].body, { tested: true, commitSha: COMMIT, buildId: null });
  });

  await t.test('delayed defaults and disappearing choices leave a usable picker without replacing the draft', async () => {
    versions = [makeVersion({ tested: true, testedInvalidatedAt: null })];
    let releaseVersions;
    versionsGate = new Promise(resolve => { releaseVersions = resolve; });
    holdEvents = true;
    heldEvents = null;
    const requestsBefore = versionsRequests;
    try {
      await visit(false);
      await waitFor(() => versionsRequests > requestsBefore);
      await openBasics();
      assert.equal(await evaluate(`${button('Continue')}.disabled`), true);
      releaseVersions();
      versionsGate = null;
      await waitFor(() => evaluate(`document.querySelectorAll('input[aria-label$=" tested"]').length`), n => n === 1);
      assert.equal(await evaluate('document.querySelector("#wizard-version") !== null'), true, 'a late sole default must leave a way to choose it');
      assert.equal(await evaluate('document.querySelector("input[placeholder=main-stage]").value'), 'offline-choice');
      await click('document.querySelector("#wizard-version")');
      await waitFor(() => evaluate('document.querySelector("[role=option]") !== null'));
      await click('document.querySelector("[role=option][data-value=\\"1\\"]")');
      assert.equal(await evaluate(`${button('Continue')}.disabled`), false);

      await waitFor(() => heldEvents !== null);
      versions = [makeVersion({ tested: true, testedInvalidatedAt: null, isDefault: false }), makeVersion({ id: 2, name: 'another-default', tested: true, testedInvalidatedAt: null })];
      heldEvents.write('event: version.changed\ndata: {}\n\n');
      await waitFor(() => evaluate(`document.querySelectorAll('input[aria-label$=" tested"]').length`), n => n === 2);
      assert.match(await evaluate('document.querySelector("#wizard-version").innerText'), /review-build/, 'a new default never replaces an explicit choice');
      versions = [versions[1]];
      heldEvents.write('event: version.changed\ndata: {}\n\n');
      await waitFor(() => evaluate(`document.querySelectorAll('input[aria-label$=" tested"]').length`), n => n === 1);
      assert.equal(await evaluate(`${button('Continue')}.disabled`), true);
      assert.equal(await evaluate('document.querySelector("#wizard-version") !== null'), true, 'removing the chosen version must leave a way to select the remaining default');
      await click('document.querySelector("#wizard-version")');
      await waitFor(() => evaluate('document.querySelector("[role=option]") !== null'));
      await click('document.querySelector("[role=option][data-value=\\"2\\"]")');
      assert.equal(await evaluate(`${button('Continue')}.disabled`), false);
      assert.equal(await evaluate('document.querySelector("input[placeholder=main-stage]").value'), 'offline-choice');
      await click('document.querySelector("button[aria-label=close]")');
    } finally {
      releaseVersions();
      versionsGate = null;
      heldEvents?.end();
      holdEvents = false;
    }
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});
