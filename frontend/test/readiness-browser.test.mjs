import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { buttonWithText, clickWhenEnabled, launchChrome, PAGE_TEXT, readWhenPresent, waitFor, watchCompletedRequests } from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../../common/src/index.ts', import.meta.url));
const base = { name: 'test-stream', kind: 'streamer', status: 'RUNNING', port_slot: 1, notes: null, last_error: null, last_error_at: null,
  created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', engine_settings: {}, has_engine_config: false, engine_config_error: null,
  stamp_id: 'a'.repeat(64), public_key: '1'.repeat(40), containers: [{ service: 'srs', ports: {} }, { service: 'bee-uploader', ports: {} }], pendingStamp: false };
const second = { ...base, name: 'second-stream', port_slot: 2 };
async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('readiness and container diagnostics use current observations in the browser', async (t) => {
  let mode = 'ready';
  let hold = false;
  let holdWallet = false;
  const held = [], logRequests = [], writes = [];
  const server = await createServer({
    root: frontend, configFile: false, cacheDir: viteCacheFor('readiness'),
    resolve: { alias: { '@streaming-infra-manager/common': common } },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [react(), { name: 't12-offline-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
        if (req.method !== 'GET') { writes.push({ path, method: req.method }); return json({}, 405); }
        if (path === '/auth/session') return json({ username: 'readiness-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
        if (path === '/profiles') return json({ profiles: [base, second] });
        if (path === '/groups') return json({ groups: [] });
        if (path === '/versions') return json([]);
        if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
        if (path === '/events' || path.startsWith('/metrics')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); return; }
        if (path.includes('/containers/') && path.endsWith('/logs')) {
          logRequests.push(path); res.setHeader('content-type', 'text/plain');
          return res.end(`Only ${path.split('/')[4]} logs for ${path.split('/')[2]}`);
        }
        function beeResponse() {
          if (mode === 'failed' && /\/(wallet|stamps|chainstate)$/.test(path)) return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
          if (path.endsWith('/readiness')) return json({ state: mode === 'failed' ? 'unreachable' : mode, observedAt: new Date().toISOString(), healthStatus: 'ok', readinessStatus: mode === 'ready' ? 'ready' : 'notReady', version: '2.8.2', apiVersion: '8.1.0', chainProgress: null });
          if (path.endsWith('/address')) return json({ ethereum: '0x' + 'b'.repeat(40) });
          if (path.endsWith('/wallet')) return json({ nativeTokenBalance: '1000000000000000000', bzzBalance: '10000000000000000' });
          if (path.endsWith('/chainstate')) return json({ chainTip: 20, block: 20, totalAmount: '1', currentPrice: '1' });
          if (path.endsWith('/stamps')) return json({ stamps: [{ batchID: base.stamp_id, batchTTL: 500000, usable: true, exists: true, depth: 20, amount: '1', utilization: 0 }] });
          if (path.endsWith('/chequebook')) return json({ address: '0x' + 'c'.repeat(40), totalBalance: '10000000000000000', availableBalance: '10000000000000000', totalSent: '0', totalReceived: '0', health: { state: 'ok', availablePlur: '10000000000000000', floorPlur: '5000000000000000' } });
          return json({}, 404);
        }
        if (path.includes('/stamp/') || path.endsWith('/chequebook')) { if (hold || (holdWallet && path.endsWith('/wallet'))) held.push(beeResponse); else beeResponse(); return; }
        return json({}, 404);
      });
    }}],
  });
  await server.listen();
  t.after(async () => { server.httpServer.closeAllConnections(); await server.close(); });
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchChrome(t, origin);
  const evidence = await evidenceDirectory('t12-browser-evidence-');
  const { call, evaluate } = browser;
  const body = () => evaluate(PAGE_TEXT);
  const hasUploader = () => evaluate(`!!${buttonWithText('Start uploader')}`);
  const click = text => clickWhenEnabled(evaluate, buttonWithText(text), `an enabled ${text} button`);
  const clickSelected = (selector, description) => clickWhenEnabled(evaluate, `document.querySelector(${JSON.stringify(selector)})`, description);
  await call('Page.navigate', { url: `${origin}/#/deployments/test-stream` });
  try { await waitFor(body, text => text.includes('Bee reports its API is ready'), 'current Bee readiness'); }
  catch (error) { console.log(await body(), browser.errors); throw error; }
  assert.equal(await hasUploader(), true);
  assert.match(await body(), /Checked \d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(await body(), /usually within a minute|Ready to stream|Watchable/);
  for (const service of ['bee-uploader', 'srs']) {
    await clickSelected(`button[aria-label="View ${service} logs"]`, `the View ${service} logs button`);
    await waitFor(body, text => text.includes(`Only ${service} logs`), `${service} selected logs`);
    assert.equal(logRequests.at(-1), `/profiles/test-stream/containers/${service}/logs`);
    await clickSelected('button[aria-label="close"]', 'the log dialog close button');
    await waitFor(() => evaluate('document.querySelector("[role=dialog]") === null'), Boolean, 'the log dialog to close');
  }
  await evaluate('window.fixtureNow = performance.now.bind(performance); performance.now = () => window.fixtureNow() + 31000');
  await waitFor(body, text => text.includes('Bee observation stale'), 'expired observation');
  assert.equal(await hasUploader(), false);
  hold = true;
  await click('Retry node checks');
  await waitFor(() => held.length, count => count >= 1, 'held reload');
  assert.equal(await hasUploader(), false);
  mode = 'failed'; hold = false; held.splice(0).forEach(reply => reply());
  await waitFor(body, text => text.includes('Bee unreachable'), 'failed reload');
  assert.equal(await hasUploader(), false);
  mode = 'initializing'; await click('Retry node checks');
  await waitFor(body, text => text.includes('Bee initializing'), 'initializing response');
  assert.match(await body(), /No completion estimate/);
  hold = true;
  await evaluate(`location.hash = '#/deployments/second-stream'`);
  await waitFor(() => held.length, count => count >= 1, 'second deployment loading');
  assert.match(await body(), /No current Bee API observation/);
  assert.equal(await hasUploader(), false);
  mode = 'ready'; hold = false; held.splice(0).forEach(reply => reply());
  await waitFor(body, text => text.includes('Bee reports its API is ready') && text.includes('second-stream'), 'new deployment observations');
  assert.equal(await hasUploader(), true);
  // A sibling wallet request must not renew an earlier probe response.
  holdWallet = true;
  await evaluate('performance.now = () => window.fixtureNow() + 62000');
  await waitFor(body, text => text.includes('Bee observation stale'), 'second expiry');
  const probeResponses = await watchCompletedRequests(evaluate, '/stamp/readiness');
  await click('Retry node checks');
  await waitFor(() => held.length, count => count >= 1, 'held wallet sibling');
  await waitFor(probeResponses, count => count > 0, 'probe response received before wallet');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await evaluate('performance.now = () => window.fixtureNow() + 93000');
  holdWallet = false; held.splice(0).forEach(reply => reply());
  await waitFor(() => evaluate(`!![...document.querySelectorAll('#storage button')].find(button => button.textContent.trim() === 'Refresh' && !button.disabled)`), Boolean, 'the storage Refresh button to be enabled again');
  assert.equal(await hasUploader(), false);
  assert.match(await body(), /Bee observation stale/);
  for (const phase of ['starting', 'restarting', null]) {
    second.status = 'DEPLOYING'; second.deployment_phase = phase;
    await call('Page.reload');
    const label = phase === 'starting' ? 'Starting' : phase === 'restarting' ? 'Restarting' : 'Deploying';
    await waitFor(body, text => text.includes(`${label}. Ingest and current container state are not yet verified.`), `${label} after page reload`);
    assert.doesNotMatch(await body(), /deployment is stopped|Stopped\. Start it/);
    assert.match(await body(), /Previous container records, current state not yet verified/);
    const engineText = await readWhenPresent(
      evaluate,
      `[...document.querySelectorAll('h3')].find(heading => heading.textContent === 'SRS 6')?.closest('.MuiPaper-root')`,
      'innerText',
      'the SRS 6 engine card',
    );
    assert.match(engineText, /State not checked/);
    assert.doesNotMatch(await body(), /own node · not running/);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  await writeFile(join(evidence, 'processes.json'), JSON.stringify({ chromePid: browser.pid, debuggingPort: browser.debuggingPort, vitePort: port, logRequests }, null, 2));
  const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true });
  await writeFile(join(evidence, 'readiness.png'), Buffer.from(data, 'base64'));
});
