import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { LONG_VERSION_NAME, seedVersions } from './fixtures/versions.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.T18_EVIDENCE_DIR;

test('version identity, states and actions fit verified narrow viewports', async (t) => {
  let versions = seedVersions();
  const writes = [];
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-version-fixture',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0];
          function json(body) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body));
          }
          if (path === '/auth/session') return json({ username: 'layout-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
          if (path === '/profiles') return json({ profiles: [] });
          if (path === '/groups') return json({ groups: [] });
          if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
          if (path === '/events') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': offline fixture\n\n');
            return;
          }
          if (path === '/versions' && req.method === 'GET') return json(versions);
          if (path?.startsWith('/versions/')) {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const text = Buffer.concat(chunks).toString();
            const body = text ? JSON.parse(text) : null;
            writes.push({ method: req.method, path, body });
            const version = versions.find((v) => v.id === Number(path.split('/')[2]));
            if (req.method === 'PATCH') { version.tested = body.tested; return json(version); }
            if (path.endsWith('/default')) { versions.forEach((v) => { v.isDefault = v === version; }); return json({}); }
            if (req.method === 'DELETE') { versions = versions.filter((v) => v !== version); return json({}); }
            if (path.endsWith('/update')) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.end('event: stdout\ndata: {"chunk":"Offline build log"}\n\nevent: done\ndata: {"code":0}\n\n');
              return;
            }
          }
          next();
        });
      },
    }],
  });
  await server.listen();
  t.after(async () => {
    server.httpServer.closeAllConnections();
    await server.close();
  });
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  await call('Page.navigate', { url: `${origin}/#/versions` });
  await waitFor(() => evaluate(`document.querySelectorAll('input[type="checkbox"]').length`), (count) => count === 6, 'version controls');
  const dimensions = [];

  for (const width of [723, 390, 1280]) {
    await t.test(`${width}px actual viewport keeps all row actions and states inside the page`, async () => {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const measurement = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('input[type="checkbox"]')].map(input => {
          const row = input.closest('article, tr');
          const visible = [...row.querySelectorAll('button, input[type="checkbox"]')].map(element => {
            const target = element.matches('input') ? element.closest('label') ?? element.closest('.MuiSwitch-root') : element;
            const box = target.getBoundingClientRect();
            let left = 0, right = innerWidth;
            for (let parent = target.parentElement; parent; parent = parent.parentElement) {
              if (['hidden', 'auto', 'scroll', 'clip'].includes(getComputedStyle(parent).overflowX)) {
                const bounds = parent.getBoundingClientRect();
                left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
              }
            }
            return { name: element.textContent || element.getAttribute('aria-label'), left: box.left, right: box.right, within: box.left >= left - 1 && box.right <= right + 1 };
          });
          return { name: input.getAttribute('aria-label'), checked: input.checked, controls: visible, text: row.innerText };
        });
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rows };
      })()`);
      dimensions.push(measurement);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true, fromSurface: true });
        await writeFile(resolve(evidence, `versions-${width}.png`), Buffer.from(data, 'base64'));
      }
      assert.equal(measurement.width, width, 'the requested viewport must actually apply');
      assert.ok(measurement.scrollWidth <= width, `page width ${measurement.scrollWidth} exceeds ${width}`);
      for (const row of measurement.rows) {
        assert.equal(row.controls.length, 4, `${row.name} preserves Tested and three actions`);
        for (const control of row.controls) assert.ok(control.within, `${row.name}: ${control.name} lies outside the visible page (${control.left}..${control.right})`);
      }
      assert.ok(measurement.rows[0].text.includes('Default'));
      assert.equal(measurement.rows[0].checked, true);
      assert.ok(measurement.rows[5].text.includes('Building'));
      assert.equal(measurement.rows[5].checked, true);
    });
  }

  await t.test('contract details open by keyboard without hiding identity or state', async () => {
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 960, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.querySelectorAll("details > summary").length'), 6);
    await evaluate(`document.querySelector('details > summary').focus()`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(() => evaluate('document.querySelector("details").open'), Boolean, 'keyboard-expanded contract');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate(`document.querySelector('input[aria-label=${JSON.stringify(`${LONG_VERSION_NAME} tested`)}]').checked`), true);
    if (evidence) {
      const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true, fromSurface: true });
      await writeFile(resolve(evidence, 'versions-390-expanded.png'), Buffer.from(data, 'base64'));
    }
  });

  if (evidence) await writeFile(resolve(evidence, 'viewport-measurements.json'), JSON.stringify({ dimensions, chromePid: browser.pid, debuggingPort: browser.debuggingPort, vitePort: address.port }, null, 2));
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  assert.deepEqual(writes, []);
});
