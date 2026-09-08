import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { assembleEngineSettingObservations, effectiveEngineDefaults, engineOverviewIdentity, engineSettingsFieldsFor } from '@streaming-infra-manager/common';
import { launchChrome, waitFor } from './support/chrome.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../../common/src/index.ts', import.meta.url));
const base = {
  name: 'observed-stream', kind: 'custom', components: ['ome', 'stream-uploader'], status: 'RUNNING', port_slot: 1,
  instance_id: 'initial-instance', engine_config_revision: 3, intent_revision: 4, stack_version_id: 1,
  engine_config_state: null, engine_config_error: null, has_engine_config: true,
  notes: 'initial observation', last_error: null, last_error_at: null,
  created_at: '2026-09-09T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z',
  engine_settings: { HLS_SEGMENT_DURATION: '7', OME_HLS_POLL_INTERVAL_MS: '750' },
  containers: [{ service: 'ome', ports: {} }, { service: 'stream-uploader', ports: {} }], pendingStamp: false,
};

function overview(profile, duration = '4') {
  const fields = engineSettingsFieldsFor('ome', { abr: false });
  const defaults = effectiveEngineDefaults('ome', { HLS_SEGMENT_DURATION: '6' }, {});
  const readings = { HLS_SEGMENT_DURATION: [{ kind: 'literal', value: duration }],
    HLS_SEGMENT_COUNT: [{ kind: 'literal', value: '8' }], OME_HLS_POLL_INTERVAL_MS: [{ kind: 'environment' }] };
  return { identity: engineOverviewIdentity(profile), engine: 'ome', abr: false, fields,
    settings: profile.engine_settings, defaults: defaults.values, defaultSources: defaults.sources,
    ...assembleEngineSettingObservations({ fields, settings: profile.engine_settings, defaults, readings }),
    live: null, liveUnavailableReason: 'Live engine status is not observed in this offline fixture.' };
}

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('engine values, read freshness and editor drafts in the actual browser', { timeout: 150000 }, async t => {
  let profile = structuredClone(base), duration = '4', hold = false, responseStatus = 200, responseIdentity = null;
  const held = [], writes = [], events = new Set(), reads = [];
  const server = await createServer({ root: frontend, configFile: false,
    resolve: { alias: { '@streaming-infra-manager/common': common } },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [react(), { name: 't11-engine-observation-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
        if (req.method !== 'GET') { writes.push({ path, method: req.method }); return json({}, 405); }
        if (path === '/auth/session') return json({ username: 'settings-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
        if (path === '/profiles') return json({ profiles: [profile] });
        if (path === '/groups') return json({ groups: [] });
        if (path === '/versions') return json([]);
        if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
        if (path === '/events' || path.startsWith('/metrics')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n');
          if (path === '/events') { events.add(res); req.on('close', () => events.delete(res)); }
          return;
        }
        if (path === '/profiles/observed-stream/engine') {
          const captured = overview(profile, duration);
          if (responseIdentity) captured.identity = responseIdentity;
          const status = responseStatus;
          const read = { revision: profile.engine_config_revision, closed: false };
          reads.push(read); res.on('close', () => { read.closed = true; });
          const reply = () => json(status === 200 ? captured : { error: 'observation_unavailable', message: 'Synthetic observation unavailable.' }, status);
          if (hold) held.push(reply); else reply();
          return;
        }
        return json({}, 404);
      });
    }}],
  });
  await server.listen();
  t.after(async () => { server.httpServer.closeAllConnections(); await server.close(); });
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const body = () => evaluate('document.body.innerText');
  const card = () => evaluate(`[...document.querySelectorAll('h3')].find(h => h.textContent === 'OvenMediaEngine')?.closest('.MuiPaper-root').innerText ?? ''`);
  const drawer = () => evaluate(`document.querySelector('.MuiDrawer-paper')?.innerText ?? ''`);
  const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw Error('Missing button'); button.click(); })()`);
  const saveDisabled = () => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Apply and recreate engine')?.disabled`);
  const typed = () => evaluate(`document.querySelector('input[aria-label="Segment duration"]')?.value`);
  const typeDuration = value => evaluate(`(() => { const input = document.querySelector('input[aria-label="Segment duration"]'); if (!input) throw Error('Missing duration input'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  function publish(patch) {
    profile = { ...profile, ...patch };
    for (const res of events) res.write(`event: profile.changed\ndata: ${JSON.stringify({ profile })}\n\n`);
  }
  function release() { hold = false; held.splice(0).forEach(reply => reply()); }
  async function reset(width = 1440) {
    release(); profile = structuredClone(base); duration = '4'; responseStatus = 200; responseIdentity = null;
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await call('Page.navigate', { url: `${origin}/#/deployments/observed-stream` });
    await call('Page.reload');
    await waitFor(body, text => text.includes('segment 4 s'), 'initial observed literal');
    await waitFor(() => events.size, n => n > 0, 'profile event stream');
  }
  async function openDraft() {
    await click('Settings');
    await waitFor(typed, value => value === '7', 'stored override draft');
    await typeDuration('9');
    assert.equal(await typed(), '9');
  }
  async function waitRevision(note) {
    await waitFor(body, text => text.includes(note), 'changed profile event');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }

  await t.test('literal value and source agree on the desktop summary, card and drawer, then on a phone', async () => {
    await reset();
    assert.match(await card(), /4\s+seconds\s+Set in config file/);
    assert.match(await body(), /segment 4 s/);
    await click('Settings');
    await waitFor(drawer, text => text.includes('Set in config file'), 'literal editor source');
    assert.match(await drawer(), /4 seconds/);
    assert.match(await drawer(), /Changing this override will not change this setting/);
    assert.doesNotMatch(await drawer(), /dropped the placeholder/);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Segment duration"]').placeholder`), 'Config controls value');
    await mkdir('/private/tmp/t11-browser-evidence', { recursive: true });
    await writeFile('/private/tmp/t11-browser-evidence/desktop.png', Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.match(await drawer(), /4 seconds/);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await writeFile('/private/tmp/t11-browser-evidence/phone.png', Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  });

  await t.test('same-millisecond config revision hides old evidence while preserving an unsaved draft', async () => {
    await reset(); await openDraft();
    hold = true; duration = '5';
    publish({ engine_config_revision: 4, notes: 'revision four arrived' });
    await waitRevision(profile.notes);
    assert.doesNotMatch(await card(), /4\s+s/);
    assert.doesNotMatch(await drawer(), /4 seconds|Default 6/);
    assert.equal(await typed(), '9');
    assert.equal(await saveDisabled(), true);
    release();
    await waitFor(body, text => text.includes('segment 5 s'), 'new revision observation');
    assert.match(await drawer(), /5 seconds/);
    assert.equal(await typed(), '9');
    assert.equal(await saveDisabled(), false);
  });

  await t.test('a failed reload cannot retain old values or enable Apply', async () => {
    await reset(); await openDraft();
    responseStatus = 503;
    publish({ engine_config_revision: 4, updated_at: '2026-09-09T00:00:01.000Z', notes: 'failed revision arrived' });
    await waitRevision(profile.notes);
    await waitFor(() => reads.at(-1)?.revision, value => value === 4, 'failed request');
    await waitFor(() => reads.at(-1)?.closed, Boolean, 'failed response completed');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.doesNotMatch(await card(), /4\s+s/);
    assert.match(await body(), /Synthetic observation unavailable\./);
    assert.doesNotMatch(await drawer(), /4 seconds|Default 6/);
    assert.equal(await typed(), '9');
    assert.equal(await saveDisabled(), true);
  });

  await t.test('a response carrying another revision is not shown as current evidence', async () => {
    await reset();
    responseIdentity = engineOverviewIdentity(base);
    duration = '5';
    publish({ engine_config_revision: 4, updated_at: '2026-09-09T00:00:01.000Z', notes: 'mismatched response arrived' });
    await waitRevision(profile.notes);
    await waitFor(() => reads.at(-1)?.revision, value => value === 4, 'mismatched request');
    await waitFor(() => reads.at(-1)?.closed, Boolean, 'mismatched response completed');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.doesNotMatch(await card(), /[45]\s+s/);
    assert.match(await body(), /changed|match/);
  });

  await t.test('a same-name replacement never adopts an open draft until it is explicitly reopened', async () => {
    await reset(); await openDraft();
    duration = '5';
    publish({ instance_id: 'replacement-instance', engine_config_revision: 0, intent_revision: 0,
      updated_at: '2026-09-09T00:00:01.000Z', notes: 'replacement arrived' });
    await waitFor(body, text => text.includes('segment 5 s'), 'replacement observation');
    assert.equal(await typed(), '9');
    assert.equal(await saveDisabled(), true);
    assert.match(await drawer(), /replaced|different deployment/);
    await evaluate(`document.querySelector('.MuiDrawer-paper button[aria-label="close"]').click()`);
    await waitFor(drawer, text => text === '', 'drawer closed');
    await openDraft();
    assert.match(await drawer(), /5 seconds/);
    assert.equal(await saveDisabled(), false);
  });

  release();
  assert.deepEqual(writes, []);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  await mkdir('/private/tmp/t11-browser-evidence', { recursive: true });
  await writeFile('/private/tmp/t11-browser-evidence/processes.json', JSON.stringify({ chromePid: browser.pid,
    debuggingPort: browser.debuggingPort, vitePort: port, version: browser.version, reads, writes }, null, 2));
});
