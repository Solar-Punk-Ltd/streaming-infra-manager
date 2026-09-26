/**
 * The SRT ingest card on a real deployment page, in a real Chrome.
 *
 * On 2026-09-22 a tester's SRT broadcast broke up for five hours and nothing on
 * any screen said so, while SRS counted about six percent of its packets
 * dropped. The card is the page saying so. This drives it through the states
 * an operator meets: a link that is breaking up with the fix beside it, one
 * that recovered what it lost, a minute with no reports, the latency step
 * leading to the SRT latency in the deployment's Stack settings card once the
 * version offers that field, and a deployment with no SRS running, which shows
 * no card and asks nothing.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

import {
  assembleEngineSettingObservations,
  effectiveEngineDefaults,
  engineOverviewIdentity,
  engineSettingsFieldsFor,
  environmentSettingReadings,
  measuredSrtIngest,
} from '@streaming-infra-manager/common';

import { runningCatalog } from './fixtures/deploymentSettings.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  launchChrome,
  PAGE_TEXT,
  paintedInView,
  stillWithin,
  waitFor,
} from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** Whether the drawer the Engine card used to open is on screen, which it never is since the drawer went. */
const ENGINE_DRAWER_OPEN = `[...document.querySelectorAll('h2')].some(heading => heading.textContent.startsWith('Engine settings for'))`;
const common = fileURLToPath(new URL('../../common/src/index.ts', import.meta.url));

const RUNNING_SRS = [{ service: 'srs', ports: {} }, { service: 'stream-uploader', ports: {} }, { service: 'bee-uploader', ports: {} }];

const base = {
  name: 'ingest-stage', kind: 'streamer', status: 'RUNNING', port_slot: 1, host: 'localhost',
  instance_id: '33333333-3333-4333-8333-333333333333', engine_config_revision: 0, intent_revision: 0,
  stack_version_id: 1, engine_config_state: null, engine_config_error: null, has_engine_config: false,
  notes: null, last_error: null, last_error_at: null, has_srt_passphrase: false,
  created_at: '2026-09-23T08:00:00.000Z', updated_at: '2026-09-23T08:00:00.000Z',
  engine_settings: {}, stamp_id: null, public_key: '1'.repeat(40), pendingStamp: false,
  containers: RUNNING_SRS,
};

/** The two reports SRS printed for the tester's broadcast of 2026-09-22. */
const BROKEN_UP = measuredSrtIngest({
  windowSeconds: 60, reports: 2, connections: 1,
  counts: { received: 12_957, lost: 761, retransmitted: 731, dropped: 763 },
});
const RECOVERED = measuredSrtIngest({
  windowSeconds: 60, reports: 6, connections: 1,
  counts: { received: 39_000, lost: 118, retransmitted: 118, dropped: 0 },
});
const NO_REPORTS = { state: 'no_reports', windowSeconds: 60 };

/** The engine setting the card's latency step leads to in the Stack settings card. */
const SRT_LATENCY_KEY = 'SRT_LATENCY';

/** The button of the latency step, which brings the setting into view. */
const RAISE_LATENCY_BUTTON = 'Change SRT latency';

/**
 * SRS's engine overview as the manager answers it. Every SRS deployment has
 * offered `SRT_LATENCY` since PR 44, so `offersLatency` false takes it out,
 * which is how the card still meets a manager that does not offer it.
 */
function overviewOf(profile, offersLatency) {
  const fields = engineSettingsFieldsFor('srs', { abr: false })
    .filter((field) => offersLatency || field.key !== SRT_LATENCY_KEY);
  const defaults = effectiveEngineDefaults('srs', {}, {});
  return {
    identity: engineOverviewIdentity(profile), engine: 'srs', abr: false, fields,
    settings: profile.engine_settings, defaults: defaults.values, defaultSources: defaults.sources,
    ...assembleEngineSettingObservations({ fields, settings: profile.engine_settings, defaults, readings: environmentSettingReadings(fields) }),
    live: null, liveUnavailableReason: 'Live engine status is not observed in this offline fixture.',
  };
}

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('the SRT ingest card says how the link is holding up, and how to fix it', { timeout: 150_000 }, async (t) => {
  let profile = structuredClone(base);
  let reading = BROKEN_UP;
  let offersLatency = false;
  let ingestReads = 0;
  const server = await createServer({
    root: frontend, configFile: false, cacheDir: viteCacheFor('srt-ingest'),
    resolve: { alias: { '@streaming-infra-manager/common': common } },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [react(), { name: 'srt-ingest-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
        if (req.method !== 'GET') return json({}, 405);
        if (path === '/auth/session') return json({ username: 'ingest-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
        if (path === '/profiles') return json({ profiles: [profile] });
        if (path === '/groups') return json({ groups: [] });
        if (path === '/versions') return json([]);
        if (path === '/versions/attempts') return json({ attempts: [] });
        if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
        if (path === '/events' || path.startsWith('/metrics')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': offline fixture\n\n');
          return;
        }
        if (path === '/profiles/ingest-stage/srt-ingest') { ingestReads += 1; return json(reading); }
        if (path === '/profiles/ingest-stage/engine') return json(overviewOf(profile, offersLatency));
        if (path === '/profiles/ingest-stage/settings') return json({ ...runningCatalog(), instanceId: profile.instance_id });
        // Every other read of the deployment is a node that does not answer,
        // which is what the page shows beside a link that is breaking up.
        if (path.startsWith('/profiles/')) return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
        return next();
      });
    } }],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const evidence = await evidenceDirectory('srt-ingest-browser-');
  const body = () => evaluate(PAGE_TEXT);
  const shows = (description, ...texts) => waitFor(body, (text) => texts.every((part) => text.includes(part)), description);
  const reload = async () => {
    await call('Page.reload');
    await shows('the deployment page', 'Readiness');
  };

  await call('Page.navigate', { url: `${origin}/#/deployments/ingest-stage` });
  await t.test('a link that is breaking up reads as bad, with the fix beside it', async () => {
    await shows('the bad link and its remedy', 'SRT ingest', 'Bad', '12,957', "The broadcaster's connection is losing packets");
    const text = await body();
    assert.match(text, /5\.9% · 763 packets/);
    assert.match(text, /&latency=4000000/);
    assert.match(text, /Until this manager offers that setting/);
    assert.equal(await evaluate(`!!${buttonWithText(RAISE_LATENCY_BUTTON)}`), false, 'no setting to lead to on this version');
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true });
    await writeFile(join(evidence, 'bad-link.png'), Buffer.from(data, 'base64'));
  });

  await t.test('the card fits a phone', async () => {
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 960, deviceScaleFactor: 1, mobile: false });
    await reload();
    await shows('the bad link on a phone', "The broadcaster's connection is losing packets");
    const page = await evaluate('({ inner: innerWidth, scroll: document.documentElement.scrollWidth })');
    assert.ok(page.scroll <= page.inner, `the page is ${page.scroll} wide in a ${page.inner} viewport`);
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true });
    await writeFile(join(evidence, 'bad-link-phone.png'), Buffer.from(data, 'base64'));
    await call('Emulation.clearDeviceMetricsOverride');
  });

  await t.test('a link that recovered everything it lost reads as healthy, with no remedy', async () => {
    reading = RECOVERED;
    await reload();
    await shows('the healthy link', 'Healthy', 'sent again in time');
    assert.doesNotMatch(await body(), /losing packets/);
  });

  await t.test('a minute with no reports says so rather than showing zeros', async () => {
    reading = NO_REPORTS;
    await reload();
    await shows('the minute with no reports', 'No SRT publisher', 'printed no SRT statistics');
    assert.doesNotMatch(await body(), /Packets received/);
  });

  await t.test('the latency step brings the Stack settings card into view at the SRT latency, focused, once the version offers the field', async () => {
    reading = BROKEN_UP;
    offersLatency = true;
    await reload();
    await shows('the latency step with its button', 'in its stack settings');
    await evaluate('scrollTo(0, 0)');

    await clickWhenEnabled(evaluate, buttonWithText(RAISE_LATENCY_BUTTON), 'the latency button in the remedy');

    await waitFor(() => evaluate('document.activeElement?.id'), (id) => id === `deployment-setting-${SRT_LATENCY_KEY}`, 'the SRT latency focused');
    const latencyRow = `document.querySelector('li[data-setting="${SRT_LATENCY_KEY}"]')`;
    assert.equal(await evaluate(paintedInView(latencyRow)), true, 'the SRT latency on screen as it is focused');
    assert.equal(await evaluate(ENGINE_DRAWER_OPEN), false, 'no engine settings drawer opened');
    await waitFor(() => evaluate(stillWithin(`document.getElementById('stack-settings')`)), Boolean, 'the settings card still');
    assert.equal(await evaluate(paintedInView(latencyRow)), true, 'the SRT latency still on screen once the card is still');
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(join(evidence, 'latency-setting.png'), Buffer.from(data, 'base64'));
  });

  await t.test('a deployment with no SRS running shows no card and asks nothing', async () => {
    profile = { ...profile, containers: [{ service: 'bee-uploader', ports: {} }] };
    const before = ingestReads;
    await reload();
    await shows('the deployment page without SRS', 'Readiness');
    assert.doesNotMatch(await body(), /SRT ingest/);
    assert.equal(ingestReads, before, 'the card asked for a reading it does not show');
  });

  // The manager keeps a deployment's container records after it stops.
  await t.test('a stopped deployment shows no card and asks nothing, though it keeps its SRS records', async () => {
    profile = { ...profile, status: 'STOPPED', containers: RUNNING_SRS };
    const before = ingestReads;
    await reload();
    await shows('the stopped deployment page', 'Readiness');
    // The card's title on a line of its own. The containers card still names the
    // srs container "media server (SRT ingest)".
    assert.doesNotMatch(await body(), /^SRT ingest$/m);
    assert.equal(ingestReads, before, 'the card asked a stopped deployment for a reading');
  });

  t.diagnostic(`screenshots in ${evidence}`);
});
