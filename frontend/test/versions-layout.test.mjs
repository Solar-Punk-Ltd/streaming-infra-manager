import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { LONG_ERROR, LONG_VERSION_NAME, seedVersions } from './fixtures/versions.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.T18_EVIDENCE_DIR;

test('version identity, states and actions fit verified narrow viewports', async (t) => {
  let versions = seedVersions();
  const writes = [];
  let activeBuild;
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
          if (path === '/versions/attempts' && req.method === 'GET') return json({ attempts: [] });
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
              res.write('event: stdout\ndata: {"chunk":"Offline build log"}\n\n');
              activeBuild = res;
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
  async function pressKey(key, code, keyCode, text) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }
  async function clickButton(name, scope = 'document') {
    const point = await evaluate(`(() => {
      const element = [...(${scope}).querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)});
      if (!element || element.disabled) throw new Error('No enabled button: ' + ${JSON.stringify(name)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  const card = (name) => `document.querySelector('input[aria-label="${name} tested"]').closest('article')`;
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
          const labels = [...row.querySelectorAll('h4, span, dt, dd, p')]
            .filter(element => element.childElementCount === 0 && element.textContent.trim() && element.checkVisibility())
            .map(element => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return {
                text: element.textContent,
                within: [...range.getClientRects()].every(rect => rect.left >= -1 && rect.right <= innerWidth + 1),
              };
            });
          return { name: input.getAttribute('aria-label'), checked: input.checked, controls: visible, labels, text: row.innerText };
        });
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rows };
      })()`);
      dimensions.push(measurement);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false, fromSurface: true });
        await writeFile(resolve(evidence, `versions-${width}.png`), Buffer.from(data, 'base64'));
      }
      assert.equal(measurement.width, width, 'the requested viewport must actually apply');
      assert.ok(measurement.scrollWidth <= width, `page width ${measurement.scrollWidth} exceeds ${width}`);
      for (const row of measurement.rows) {
        assert.equal(row.controls.length, 4, `${row.name} preserves Tested and three actions`);
        for (const control of row.controls) assert.ok(control.within, `${row.name}: ${control.name} lies outside the visible page (${control.left}..${control.right})`);
        for (const label of row.labels) assert.ok(label.within, `${row.name}: ${label.text} extends beyond the viewport`);
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
    await pressKey('Enter', 'Enter', 13, '\r');
    await waitFor(() => evaluate('document.querySelector("details").open'), Boolean, 'keyboard-expanded contract');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate(`document.querySelector('input[aria-label=${JSON.stringify(`${LONG_VERSION_NAME} tested`)}]').checked`), true);
    if (evidence) {
      const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false, fromSurface: true });
      await writeFile(resolve(evidence, 'versions-390-expanded.png'), Buffer.from(data, 'base64'));
    }
  });

  await t.test('a default updated to another build keeps its dated warning readable at every viewport', async () => {
    const before = { ...versions[0] };
    const invalidatedAt = '2026-09-08T08:15:00.000Z';
    const date = await evaluate(`import('/src/format.ts').then(({formatDateTime}) => formatDateTime(${JSON.stringify(invalidatedAt)}))`);
    versions[0] = { ...before, tested: false, buildId: `${'1'.repeat(40)}-r3`, testedInvalidatedAt: invalidatedAt };
    try {
      await clickButton('Refresh');
      await waitFor(() => evaluate(`!document.querySelector('input[aria-label="${LONG_VERSION_NAME} tested"]').checked`));
      for (const width of [723, 390, 1280]) {
        await call('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
        const reading = await evaluate(`(() => {
          const row = ${card(LONG_VERSION_NAME)};
          row.scrollIntoView({ block: 'start' });
          const topBar = document.querySelector('h1').parentElement.getBoundingClientRect();
          window.scrollBy(0, -topBar.height - 12);
          const warning = [...row.querySelectorAll('p')].find(el => el.textContent.includes('Not tested since the update on'));
          const range = document.createRange();
          if (warning) range.selectNodeContents(warning);
          const controls = [...row.querySelectorAll('button, input[type=checkbox]')].map(el => {
            const rect = (el.closest('label') ?? el).getBoundingClientRect();
            return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= topBar.bottom && rect.bottom <= innerHeight;
          });
          return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: row.innerText,
            warning: warning?.textContent, warningFits: warning ? [...range.getClientRects()].every(rect => rect.left >= -1 && rect.right <= innerWidth + 1) : false,
            warningVisible: warning ? warning.getBoundingClientRect().top >= topBar.bottom && warning.getBoundingClientRect().bottom <= innerHeight : false,
            controls };
        })()`);
        assert.equal(reading.width, width);
        assert.ok(reading.scrollWidth <= width);
        assert.equal(reading.warning, `Not tested since the update on ${date}.`);
        assert.equal(reading.warningFits, true);
        assert.equal(reading.warningVisible, true);
        assert.ok(reading.text.includes('Default'));
        assert.ok(reading.text.includes('1111111-r3'));
        assert.deepEqual(reading.controls, [true, true, true, true]);
        if (evidence) {
          const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false, fromSurface: true });
          await writeFile(resolve(evidence, `versions-${width}-approval-warning.png`), Buffer.from(data, 'base64'));
        }
      }
    } finally {
      versions[0] = before;
      await clickButton('Refresh');
      await waitFor(() => evaluate(`document.querySelector('input[aria-label="${LONG_VERSION_NAME} tested"]').checked`));
    }
  });

  await t.test('a missing immutable identity disables approval while a legacy commit remains eligible', async () => {
    const before = { ...versions[2] };
    versions[2] = { ...before, buildId: null };
    try {
      await clickButton('Refresh');
      await waitFor(() => evaluate(`(${card('candidate')}).innerText.includes('no build yet')`));
      assert.equal(await evaluate(`document.querySelector('input[aria-label="candidate tested"]').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('input[aria-label="bundled tested"]').disabled`), false);
    } finally {
      versions[2] = before;
      await clickButton('Refresh');
      await waitFor(() => evaluate(`(${card('candidate')}).innerText.includes('3333333-r2')`));
    }
  });

  await t.test('Tested help explains distinct builds at one commit', async () => {
    const point = await evaluate(`(() => {
      const label = document.querySelector('input[aria-label="candidate tested"]').closest('label');
      label.scrollIntoView({ block: 'center' });
      const rect = label.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await waitFor(() => evaluate('document.querySelector("[role=tooltip]") !== null'));
    const help = await evaluate('document.querySelector("[role=tooltip]").innerText');
    assert.match(help, /different build clears approval, even at the same commit/);
    assert.match(help, /Legacy versions/);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  });

  await t.test('Tested retains the shown build and commit and default still requires confirmation', async () => {
    assert.equal(await evaluate(`[...(${card('candidate')}).querySelectorAll('button')].find(button => button.textContent === 'Set as default').disabled`), true);
    await evaluate(`document.querySelector('input[aria-label="candidate tested"]').focus()`);
    await pressKey(' ', 'Space', 32, ' ');
    await waitFor(() => writes.length, (count) => count === 1, 'tested request');
    assert.deepEqual(writes[0], { method: 'PATCH', path: '/versions/3', body: { tested: true, commitSha: '3'.repeat(40), buildId: `${'3'.repeat(40)}-r2` } });
    await waitFor(() => evaluate(`document.querySelector('input[aria-label="candidate tested"]').checked`));
    await clickButton('Set as default', card('candidate'));
    assert.equal(writes.length, 1, 'opening confirmation does not mutate default');
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog]"))'));
    await clickButton('Set as default', 'document.querySelector("[role=dialog]")');
    await waitFor(() => writes.length, (count) => count === 2, 'default request');
    assert.deepEqual(writes[1], { method: 'POST', path: '/versions/3/default', body: {} });
    await waitFor(() => evaluate(`(${card('candidate')}).innerText.includes('Default')`));
  });

  await t.test('an active build keeps default and tested visible and leaves its log after failure', async () => {
    await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'));
    await clickButton('Update', card(LONG_VERSION_NAME));
    await waitFor(() => Boolean(activeBuild));
    await waitFor(() => evaluate(`(${card(LONG_VERSION_NAME)}).querySelector('button').disabled`));
    assert.equal(await evaluate(`document.querySelector('input[aria-label="${LONG_VERSION_NAME} tested"]').checked`), true);
    assert.equal(await evaluate(`(${card('candidate')}).innerText.includes('Default')`), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate(`document.body.innerText.includes('Building ${LONG_VERSION_NAME}')`), true);
    activeBuild.write(`event: stderr\ndata: ${JSON.stringify({ chunk: LONG_ERROR })}\n\n`);
    activeBuild.end('event: done\ndata: {"code":1}\n\n');
    activeBuild = undefined;
    await waitFor(() => evaluate(`document.body.innerText.includes('Build log, ${LONG_VERSION_NAME}')`));
    assert.equal(await evaluate(`document.body.innerText.includes('Offline build log')`), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await clickButton('Dismiss');
    await waitFor(() => evaluate(`!document.body.innerText.includes('Build log, ${LONG_VERSION_NAME}')`));
  });

  await t.test('the bundled card offers the rebuild the host can now do, and names the commit', async () => {
    const bundled = await evaluate(`(() => {
      const row = ${card('bundled')};
      const update = [...row.querySelectorAll('button')].find(button => button.textContent === 'Update');
      return { enabled: update ? !update.disabled : null, text: row.innerText };
    })()`);

    assert.equal(bundled.enabled, true, 'the host fetches and builds the pinned commit, so Update is a thing this card does');
    assert.match(bundled.text, /Commit 2{6,}/, 'and the card says which commit it would rebuild');
  });

  await t.test('approval can be withdrawn and removal still confirms before sending', async () => {
    await evaluate(`document.querySelector('input[aria-label="rebuilding-tested-version tested"]').focus()`);
    await pressKey(' ', 'Space', 32, ' ');
    await waitFor(() => writes.length, (count) => count === 4);
    assert.deepEqual(writes[3], { method: 'PATCH', path: '/versions/6', body: { tested: false } });
    await waitFor(() => evaluate(`!document.querySelector('input[aria-label="rebuilding-tested-version tested"]').checked`));
    assert.equal(await evaluate(`document.querySelector('input[aria-label="rebuilding-tested-version tested"]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="failed-first-build tested"]').disabled`), true);
    assert.equal(await evaluate(`[...(${card('bundled')}).querySelectorAll('button')].find(button => button.textContent === 'Remove').disabled`), true);
    await clickButton('Remove', card('failed-first-build'));
    assert.equal(writes.length, 4, 'opening confirmation does not remove a version');
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog]"))'));
    await clickButton('Remove', 'document.querySelector("[role=dialog]")');
    await waitFor(() => writes.length, (count) => count === 5);
    assert.deepEqual(writes[4], { method: 'DELETE', path: '/versions/4', body: null });
    await waitFor(() => evaluate(`!document.querySelector('input[aria-label="failed-first-build tested"]')`));
  });

  if (evidence) {
    await writeFile(resolve(evidence, 'viewport-measurements.json'), JSON.stringify({
      dimensions,
      chrome: browser.version,
      chromePid: browser.pid,
      chromeProfile: browser.profile,
      debuggingPort: browser.debuggingPort,
      vitePort: address.port,
    }, null, 2));
  }
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  assert.equal(writes.length, 5);
});
