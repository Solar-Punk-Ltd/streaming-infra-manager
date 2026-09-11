/**
 * That a deployment page stays inside its own width, and that a failed
 * deploy's log cannot push the rest of the page out of reach.
 *
 * Both were measured on 2026-09-11 against a real manager. A deployment with
 * one container record made the page 723 pixels wide in a 523 pixel viewport,
 * because the container table has no scroll box of its own, so the whole page
 * slid sideways. The same page put a first deploy's image pull output, 135
 * lines of it, in the card above, which pushed everything below down by about
 * two and a half thousand pixels and left the one line that says what failed
 * at the bottom of it.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, PAGE_TEXT, waitFor } from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** What `docker compose` prints while it pulls an image, which is most of a first deploy's output. */
const PULL_LOG = [
  ...Array.from({ length: 130 }, (_, line) => ` b156da58ef2a Extracting ${line}B`),
  ' Image ethersphere/bee:2.8.2 Pulled ',
  ' Container layout-stage-srs-1 Started ',
  "Error response from daemon: ports are not available: exposing port TCP 10.200.0.1:10015 -> 127.0.0.1:0: listen tcp4 10.200.0.1:10015: bind: can't assign requested address",
].join('\n');

const profile = {
  name: 'layout-stage', kind: 'streamer', status: 'RUNNING', port_slot: 1, host: 'localhost',
  notes: null, last_error: PULL_LOG, last_error_at: '2026-09-11T06:58:00Z',
  created_at: '2026-09-11T06:51:00Z', updated_at: '2026-09-11T06:58:00Z',
  engine_settings: {}, has_engine_config: false, engine_config_error: null,
  stamp_id: null, public_key: '1'.repeat(40), pendingStamp: false,
  containers: [{ service: 'srs', ports: { SRS_SRT_PORT: 10011, SRS_ADAPTER_PORT: 10010, SRS_HTTP_API_PORT: 10019 } }],
};

test('a deployment page fits its viewport and bounds a failed deploy log', async (t) => {
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('deployment-layout'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-deployment-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
          if (path === '/auth/session') return json({ username: 'layout-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
          if (path === '/profiles') return json({ profiles: [profile] });
          if (path === '/groups') return json({ groups: [] });
          if (path === '/versions') return json([]);
          if (path === '/versions/attempts') return json({ attempts: [] });
          if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
          if (path === '/events' || path?.startsWith('/metrics')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': offline fixture\n\n');
            return;
          }
          // The node of a deployment whose deploy failed answers nothing, which
          // is the state the page was measured in.
          if (path?.startsWith('/profiles/')) return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
          return next();
        });
      },
    }],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;

  const logBox = `[...document.querySelectorAll('pre')].find(node => node.textContent.includes('ports are not available'))`;
  const loaded = () => waitFor(() => evaluate(PAGE_TEXT), text => text.includes('Last deploy failed') && text.includes('Containers'), 'the deployment page');
  await call('Page.navigate', { url: `${origin}/#/deployments/layout-stage` });
  await loaded();

  for (const width of [390, 723, 1280]) {
    await t.test(`${width}px keeps the page inside its own width`, async () => {
      // Each width is a fresh load, which is how a reader arrives at the page.
      await call('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      await call('Page.reload');
      await loaded();
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

      const page = await evaluate('({ inner: innerWidth, scroll: document.documentElement.scrollWidth })');
      assert.ok(page.scroll <= page.inner, `the page is ${page.scroll} wide in a ${page.inner} viewport, so it scrolls sideways`);

      const log = await evaluate(`(() => { const node = ${logBox}; return node && { client: node.clientHeight, scroll: node.scrollHeight, top: node.scrollTop }; })()`);
      assert.ok(log, 'the failed deploy log is on the page');
      assert.ok(log.client <= 400, `the log takes ${log.client} pixels of the page rather than a bounded box`);
      assert.ok(log.scroll > log.client, 'a log this long scrolls inside its own box');
      assert.ok(log.top + log.client >= log.scroll - 2, 'and it opens at the line that says what failed');
    });
  }
  await call('Emulation.clearDeviceMetricsOverride');
});
