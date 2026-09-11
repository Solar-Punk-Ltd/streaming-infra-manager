import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { buttonWithText, clickWhenEnabled, fillWhenPresent, launchChrome, PAGE_TEXT, readWhenPresent, waitFor, watchCompletedRequests } from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/**
 * A wizard step can sit behind a Vite dependency re-optimization the first time
 * a cold cache meets it, which once took the Continue button past the default
 * fifteen seconds on a busy machine. The budget is only ever spent while the
 * button is missing, so a fast run pays nothing for it.
 */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const frontend = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../../common/src/index.ts', import.meta.url));
const rungs = ['360p', '480p', '720p', '1080p'];
const group = { id: 79, name: 'chosen-pool', kind: 'abr-node-pool', size: rungs.length, created_at: '2026-09-08T00:00:00Z' };
const profiles = rungs.map((rung, index) => ({ name: `${group.name}-${rung}`, group_id: group.id, kind: 'custom', status: 'RUNNING',
  host: 'localhost', components: ['bee-uploader'], containers: [{ service: 'bee-uploader', ports: {} }], stamp_id: null,
  port_slot: index + 1, notes: null, created_at: group.created_at, updated_at: group.created_at, engine_settings: {},
  has_engine_config: false, engine_config_error: null, public_key: null, last_error: null, last_error_at: null }));
const version = { id: 7, name: 'Fixture', gitRef: 'fixture', status: 'ready', isDefault: true, tested: true, contract: null, createdAt: group.created_at };
const external = rungs.map(rung => `${rung}@http://external.example:1633<${'a'.repeat(64)}>`).join(' ');
// These values are synthetic fixtures. No real credential is read by this test.
const key = `0x${'1'.repeat(64)}`;
const passphrase = 'synthetic-uploader-passphrase';
async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('pool setup preserves the uploader draft and leaves unrelated creation paths available', async t => {
  let resultMode = 'success';
  let signedIn = true;
  let globalsReady = false;
  let nodeMode = 'unfunded';
  let holdRefresh = true;
  let holdAfterWrite = 0;
  const writes = [], held = [], refreshes = [], freshMembership = [];
  const server = await createServer({ root: frontend, configFile: false, cacheDir: viteCacheFor('pool-draft'),
    resolve: { alias: { '@streaming-infra-manager/common': common } },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [react(), { name: 't15-offline-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
        const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method !== 'GET') {
          let body = ''; req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const parsed = body ? JSON.parse(body) : {};
            writes.push({ path, method: req.method, body: parsed });
            if (path !== '/groups' || req.method !== 'POST') return json({}, 405);
            const reply = () => resultMode === 'failed' ? json({ error: 'fixture_failure', message: 'Pool creation refused by fixture' }, 409)
              : resultMode === 'null' ? json(null, 202)
              : json({ group: resultMode === 'incompatible' ? { ...group, kind: 'standard' } : group,
                profiles: resultMode === 'malformed-member' ? [{ ...profiles[0], containers: null }, ...profiles.slice(1)] : profiles }, 202);
            if (resultMode === 'held') held.push(reply); else reply();
          }); return;
        }
        if (path === '/auth/session') return signedIn ? json({ username: 'pool-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' }) : json({}, 401);
        if (path === '/profiles' || path === '/groups') {
          const reply = () => json(path === '/profiles' ? { profiles: globalsReady ? profiles : [] } : { groups: globalsReady ? [group] : [] });
          if (writes.length > holdAfterWrite && holdRefresh) {
            const uncached = /no-cache|no-store/.test(req.headers['cache-control'] ?? '');
            (uncached ? freshMembership : refreshes).push({ path, reply });
          } else reply();
          return;
        }
        if (path === '/versions') return json([version]);
        if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
        if (path === '/events' || path.startsWith('/metrics')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); return; }
        if (path.endsWith('/bee-publishers')) return json({ ready: false, value: null, rungs: [], missing: rungs.map(rung => ({ rung, reason: 'no stamp' })), warnings: [] });
        if (path.endsWith('/readiness')) return json({ state: nodeMode === 'unknown' ? 'unknown' : 'ready', observedAt: new Date().toISOString(), healthStatus: 'ok', readinessStatus: nodeMode === 'unknown' ? null : 'ready', chainProgress: null });
        if (path.endsWith('/wallet')) return nodeMode === 'unknown' ? json({}, 503) : json({ nativeTokenBalance: '0', bzzBalance: '0' });
        if (path.endsWith('/address')) return json({ ethereum: `0x${'b'.repeat(40)}` });
        if (path.endsWith('/stamps')) return json({ stamps: [] });
        if (path.endsWith('/chainstate')) return json({ chainTip: 20, block: 20, totalAmount: '1', currentPrice: '1' });
        if (path.endsWith('/chequebook')) return json({ health: { state: 'unknown', availablePlur: null, floorPlur: '5000000000000000' } });
        return json({}, 404);
      });
    }}],
  });
  await server.listen();
  t.after(async () => { server.httpServer.closeAllConnections(); await server.close(); });
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchChrome(t, origin);
  const evidence = await evidenceDirectory('t15-browser-evidence-');
  const { call, evaluate } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const found = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const click = async (text, timeoutMs = COLD_OPTIMIZE_BUDGET_MS) => {
    await clickWhenEnabled(evaluate, buttonWithText(text), `an enabled ${text} button`, timeoutMs);
    await settled();
  };
  const clickSelected = async (selector, description) => {
    await clickWhenEnabled(evaluate, found(selector), description);
    await settled();
  };
  const choose = async text => {
    const choice = `[...document.querySelectorAll('input[type=radio], [role=radio], label')].find(node => node.getAttribute('aria-label') === ${JSON.stringify(text)} || node.textContent.trim().startsWith(${JSON.stringify(text)}))`;
    await clickWhenEnabled(evaluate, choice, `the ${text} choice`);
    await settled();
  };
  const fill = (selector, value) => fillWhenPresent(evaluate, found(selector), value, `the ${selector} field`);
  const valueOf = (selector, description) => readWhenPresent(evaluate, found(selector), 'value', description);
  const close = () => clickSelected('[role=dialog] button[aria-label="close"]', 'the dialog close button');
  const next = async () => { await click('Continue'); await settled(); };
  /**
   * The Basics step offers a version picker exactly when the wizard needs the
   * choice made: a sole tested default read when the wizard opened is taken
   * silently, but a versions list that answers after the wizard opened leaves
   * the field empty on purpose, and Continue stays disabled until one is
   * picked. Which of the two a run gets is a race the runner loses often
   * enough, so every Continue out of Basics goes through here.
   */
  const continueFromBasics = async () => {
    const offered = await evaluate(`(() => {
      const field = ${found('#wizard-version')};
      if (!field) return false;
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      return true;
    })()`);
    if (offered) await clickSelected('[role="option"][data-value="7"]', 'the explicit fixture version');
    await next();
  };
  const startUploader = async () => {
    await click('New deployment'); await choose('ABR uploader'); await next();
    await fill('input[placeholder="main-stage"]', 'retained-uploader');
    await fill('textarea[placeholder="What is this for?"]', 'retained note');
    await continueFromBasics();
    await waitFor(body, text => text.includes('Create a storage pool'), 'pool prerequisite action');
    await choose('Type my own'); await fill('input[placeholder="my-stage-passphrase-2026"]', passphrase);
    await choose('Use an existing key'); await fill('input[placeholder="0x plus 64 hex characters"]', key);
  };
  const createPool = async () => {
    await click('Create a storage pool');
    await fill('input[placeholder="abr-pool-2"]', group.name);
    await next(); await next(); await click('Create pool (4 nodes)');
  };
  const assertDraft = async () => {
    assert.equal(await valueOf('input[placeholder="my-stage-passphrase-2026"]', 'the retained passphrase'), passphrase);
    assert.equal(await valueOf('input[placeholder="0x plus 64 hex characters"]', 'the retained key'), key);
    assert.equal(await evaluate(`localStorage.length === 0 && sessionStorage.length === 0`), true);
    assert.equal(await evaluate(`location.href.includes('retained-uploader') || location.href.includes(${JSON.stringify(passphrase)})`), false);
    await click('Back');
    assert.equal(await valueOf('input[placeholder="main-stage"]', 'the retained deployment name'), 'retained-uploader');
    assert.equal(await valueOf('textarea[placeholder="What is this for?"]', 'the retained note'), 'retained note');
    await next();
  };
  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, text => text.includes('New deployment'), 'the app to boot');
  await startUploader();
  await click('Create a storage pool');
  assert.equal(await valueOf('input[placeholder="abr-pool-2"]', 'the empty pool name field'), '');
  await click('Return to uploader'); await assertDraft();
  await createPool();
  await waitFor(body, text => text.includes('Storage pool created and selected'), 'successful return');
  await waitFor(() => freshMembership.length, count => count === 2, 'fresh successful membership');
  globalsReady = true; freshMembership.splice(0).forEach(entry => entry.reply());
  await assertDraft();
  assert.match(await readWhenPresent(evaluate, found('[role=combobox][aria-label="Storage pool"]'), 'textContent', 'the selected storage pool'), /chosen-pool/);
  await waitFor(body, text => text.includes('Node needs funding') && text.includes('Needs a stamp'), 'funding and stamp blockers');
  assert.match(await body(), /publishing have not been verified/);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['abr_ladder', 'group_name', 'host', 'kind', 'notes', 'size', 'stack_version_id']);
  assert.equal(writes[0].body.notes, null);
  assert.equal(writes[0].body.stack_version_id, 7);
  await clickSelected('[role=dialog] .MuiAccordionSummary-root', 'the node details summary');
  await waitFor(() => evaluate(`!!document.querySelector('[role=dialog] .MuiCollapse-entered')`), Boolean, 'expanded node details');
  await waitFor(() => evaluate(`(() => {
    const summary = ${found('[role=dialog] .MuiAccordionSummary-root')};
    if (!summary) return false;
    summary.scrollIntoView({ block: 'start' });
    return true;
  })()`), Boolean, 'the node details summary to scroll into view');
  const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true });
  await writeFile(join(evidence, 'pool-prerequisites.png'), Buffer.from(data, 'base64'));
  nodeMode = 'unknown'; await click('Refresh pool checks');
  await waitFor(body, text => text.includes('Bee API not checked') && text.includes('Funding not checked'), 'unknown observations');
  holdRefresh = false; refreshes.splice(0).forEach(entry => entry.reply());
  await close(); await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), Boolean, 'the uploader dialog to close');
  globalsReady = false; await call('Page.reload');
  await waitFor(body, text => text.includes('New deployment'), 'the app to boot after the reload');
  // Fresh absence wins in both orders relative to older compatible global lists.
  for (const oldFirst of [false, true]) {
    holdAfterWrite = writes.length; holdRefresh = true;
    await startUploader(); await createPool();
    await waitFor(body, text => text.includes('Storage pool created and selected'), 'accepted pool for ordering check');
    await waitFor(() => freshMembership.length, count => count === 2, 'independent no-store membership pair');
    assert.deepEqual(freshMembership.map(entry => entry.path).sort(), ['/groups', '/profiles']);
    assert.ok(refreshes.length >= 2, 'older ordinary reads remain held independently');
    const releaseOld = async () => {
      globalsReady = true; holdRefresh = false; refreshes.splice(0).forEach(entry => entry.reply());
      await waitFor(body, text => text.includes('1 node pool'), 'older compatible global membership rendered');
    };
    if (oldFirst) await releaseOld();
    globalsReady = false; freshMembership.splice(0).forEach(entry => entry.reply());
    await waitFor(body, text => text.includes('no longer available as a compatible pool'), oldFirst ? 'fresh absence after older globals' : 'deleted before initial catch-up');
    if (!oldFirst) await releaseOld();
    assert.equal(await evaluate(`document.querySelector('[role=combobox][aria-label="Storage pool"]')?.textContent.includes('chosen-pool') ?? false`), false);
    await assertDraft();
    await close(); await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), Boolean, 'the uploader dialog to close');
    globalsReady = false; await call('Page.reload');
    await waitFor(body, text => text.includes('New deployment'), 'the app to boot after the reload');
  }
  // Incompatible and refused creation keep the original uploader choice and draft.
  for (const mode of ['incompatible', 'null', 'malformed-member', 'failed']) {
    resultMode = mode; await startUploader(); await createPool();
    await waitFor(body, text => text.includes(mode === 'failed' ? 'Pool creation refused by fixture' : 'could not select'), mode);
    if (mode === 'failed') await click('Return to uploader');
    await assertDraft();
    assert.equal(await evaluate(`!!document.querySelector('[role=combobox][aria-label="Storage pool"]')`), false);
    await close(); await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), Boolean, 'the uploader dialog to close');
  }
  // A late pool response cannot reopen a cancelled uploader or change the route.
  resultMode = 'held'; await startUploader(); await createPool();
  await waitFor(() => held.length, count => count === 1, 'pending pool request');
  const routeBefore = await evaluate('location.hash');
  await close(); await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), Boolean, 'the uploader dialog to close');
  const latePoolResponses = await watchCompletedRequests(evaluate, '/groups');
  resultMode = 'success'; held.splice(0).forEach(reply => reply());
  await waitFor(latePoolResponses, count => count > 0, 'the late pool response to be fetched');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate('location.hash'), routeBefore);
  assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'), false);
  await click('New deployment'); await choose('ABR uploader'); await next();
  assert.equal(await valueOf('input[placeholder="main-stage"]', 'the empty deployment name field'), '');
  await close();
  // Sign-out also discards a pending draft before its response arrives.
  resultMode = 'held'; await startUploader(); await createPool();
  await waitFor(() => held.length, count => count === 1, 'pending before sign-out');
  signedIn = false;
  await evaluate(`import('/src/http.ts').then(module => module.apiFetch('/auth/session')).catch(() => undefined)`);
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), Boolean, 'the dialog to close when the session goes');
  resultMode = 'success'; held.splice(0).forEach(reply => reply());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate('location.hash'), routeBefore);
  signedIn = true; await call('Page.reload');
  await waitFor(body, text => text.includes('New deployment'), 'the app to boot after the reload');
  await click('New deployment'); await choose('ABR uploader'); await next();
  assert.equal(await valueOf('input[placeholder="main-stage"]', 'the empty deployment name field'), '');
  await fill('input[placeholder="main-stage"]', 'external-uploader'); await continueFromBasics();
  await fill('textarea[placeholder^="360p@"]', external); await next();
  assert.match(await body(), /Review/);
  assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent === 'Deploy' && !button.disabled)`), true);
  await close();
  // The existing custom and group controls remain reachable.
  await click('New deployment'); await choose('Custom'); await next();
  await fill('input[placeholder="main-stage"]', 'custom-group');
  await clickSelected('input[type=checkbox]', 'the group checkbox');
  assert.match(await body(), /How many/);
  await continueFromBasics(); assert.match(await body(), /Components/);
  assert.equal(writes.filter(write => write.path === '/profiles').length, 0);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  await writeFile(join(evidence, 'processes.json'), JSON.stringify({ chromePid: browser.pid, debuggingPort: browser.debuggingPort, vitePort: port }, null, 2));
});
