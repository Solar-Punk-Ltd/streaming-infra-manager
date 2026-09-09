import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { seedVersions } from './fixtures/versions.mjs';
import { seedSettings } from './fixtures/versionSettings.mjs';

/**
 * The settings page of one version, in headless Chrome against an offline
 * fixture. Run on its own: `node --test frontend/test/version-settings-browser.test.mjs`.
 *
 * What it holds is what an operator has to be able to trust. A secret is
 * masked until they ask for it, a value that still equals the version's own
 * default says so, a key the manager fills per deployment says that too, and a
 * save that lost a race says so with a way back rather than writing over
 * somebody else's edit. And all of it has to be usable on a phone, because
 * that is where an operator reads a page during an incident.
 */

const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.T18_EVIDENCE_DIR;

const NARROW = 390;

test('a version settings page reads, masks and saves at a narrow viewport', async (t) => {
  const versions = seedVersions();
  let settings = seedSettings();
  const writes = [];
  /** The generation the next save is told to expect, so a stale save can be staged. */
  let saveConflict = false;
  let applyBusy = false;
  /** Whether apply answers the build that already carries the settings rather than a new one. */
  let applyReused = false;

  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-version-settings-fixture',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0];
          function json(body, status = 200) {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body));
          }
          if (path === '/auth/session') return json({ username: 'settings-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
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

          if (path === '/versions/3/settings' && req.method === 'GET') return json(settings);
          if (path === '/versions/5/settings' && req.method === 'GET') {
            return json({ error: 'settings_not_ready', name: 'building-first-version', message: 'building-first-version has no settings yet. They are seeded from the stack samples by the first build of a version, and this one has none.' }, 409);
          }

          if (path === '/versions/3/settings' || path === '/versions/3/settings/apply') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const text = Buffer.concat(chunks).toString();
            writes.push({ method: req.method, path, body: text ? JSON.parse(text) : null });
            if (path.endsWith('/apply')) {
              if (applyBusy) return json({ error: 'stack_build_busy', name: 'other-version', message: 'other-version is building. Wait for it to finish, then try again.' }, 409);
              settings = { ...settings, buildGeneration: settings.generation };
              return json({
                buildId: applyReused
                  ? '3333333333333333333333333333333333333333-r2'
                  : '3333333333333333333333333333333333333333-r3',
                reused: applyReused,
              });
            }
            // The real check, not only the staged one: a save naming a revision
            // the files have moved past is what the manager refuses, and a page
            // that lost track of its own save sends exactly that.
            const stale = JSON.parse(text).expectedGeneration !== settings.generation;
            if (saveConflict || stale) {
              return json({ error: 'settings_changed', name: 'candidate', generation: settings.generation, message: 'candidate settings changed since this page loaded.' }, 409);
            }
            settings = { ...settings, generation: settings.generation + 1 };
            return json({ generation: settings.generation });
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

  /** Types into a field the way a person does, so React sees every keystroke. */
  async function typeInto(label, value) {
    await evaluate(`(() => {
      const field = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  const fieldOf = (key) => `document.querySelector('input[aria-label="${key}"]')`;
  const rowOf = (key) => `${fieldOf(key)}.closest('li')`;

  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/#/versions/3/settings` });
  await waitFor(() => evaluate(`Boolean(${fieldOf('API_AUTH_TOKEN')})`), Boolean, 'the settings fields');

  await t.test('every file of the set is a section, base env first', async () => {
    const headings = await evaluate(`[...document.querySelectorAll('h3, h4, h5, h6')].map(el => el.textContent.trim())`);

    assert.ok(headings.includes('.env'), headings.join(' '));
    assert.ok(headings.includes('deploy/config.json'), headings.join(' '));
    assert.ok(headings.includes('engines/srs/.env'), headings.join(' '));
    assert.ok(headings.indexOf('.env') < headings.indexOf('deploy/config.json'));
    assert.ok(headings.indexOf('deploy/config.json') < headings.indexOf('engines/srs/.env'));
  });

  await t.test('the header says applied while the current build carries the saved revision', async () => {
    assert.match(await evaluate('document.body.innerText'), /revision 4/);
    assert.match(await evaluate('document.body.innerText'), /applied/);
    assert.equal((await evaluate('document.body.innerText')).includes('do not have these changes yet'), false);
  });

  await t.test('a secret is masked until it is revealed, and hidden again after', async () => {
    assert.equal(await evaluate(`${fieldOf('API_AUTH_TOKEN')}.type`), 'password');
    assert.equal(await evaluate(`${fieldOf('API_PORT')}.type`), 'text');

    await clickButton('Reveal', rowOf('API_AUTH_TOKEN'));
    await waitFor(() => evaluate(`${fieldOf('API_AUTH_TOKEN')}.type`), (type) => type === 'text', 'the revealed token');

    await clickButton('Hide', rowOf('API_AUTH_TOKEN'));
    await waitFor(() => evaluate(`${fieldOf('API_AUTH_TOKEN')}.type`), (type) => type === 'password', 'the masked token');
  });

  await t.test('a key at the version default says so, and one the manager fills says that', async () => {
    const marks = async (key) => evaluate(`[...(${rowOf(key)}).querySelectorAll('.MuiChip-label')].map(el => el.textContent.trim())`);

    assert.deepEqual(await marks('API_PORT'), ['default']);
    assert.deepEqual(await marks('API_AUTH_TOKEN'), ['generated']);
    assert.match(
      await evaluate(`(${rowOf('API_AUTH_TOKEN')}).innerText`),
      /Set per deployment by the manager unless you set a value here\./,
    );
    assert.match(
      await evaluate(`(${rowOf('API_AUTH_TOKEN')}).innerText`),
      /Bearer token for every gated route/,
    );
  });

  await t.test('nothing is offered to save until something is typed', async () => {
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').disabled`), true);
    assert.ok((await evaluate('document.body.innerText')).includes('Nothing changed yet'));
    assert.equal(writes.length, 0);
  });

  await t.test('apply is offered only where it would change something', async () => {
    const disabled = await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save and apply').disabled`);

    assert.equal(disabled, true, 'nothing is edited and the build already carries the revision');
  });

  await t.test('the page fits the narrow viewport it was measured at', async () => {
    const measurement = await evaluate(`(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      fields: [...document.querySelectorAll('input[aria-label], textarea[aria-label]')].map(el => {
        const box = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label'), within: box.left >= -1 && box.right <= innerWidth + 1 };
      }),
    }))()`);

    assert.equal(measurement.width, NARROW);
    assert.ok(measurement.scrollWidth <= NARROW, `page width ${measurement.scrollWidth} exceeds ${NARROW}`);
    for (const field of measurement.fields) {
      assert.ok(field.within, `${field.name} lies outside the visible page`);
    }
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false, fromSurface: true });
      await writeFile(resolve(evidence, `version-settings-${NARROW}.png`), Buffer.from(data, 'base64'));
    }
  });

  await t.test('a save sends the key that moved and no other', async () => {
    await typeInto('API_PORT', '3100');
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').disabled`), (off) => off === false, 'an enabled Save');

    await clickButton('Save');
    await waitFor(() => writes.length, (count) => count === 1, 'the save request');

    assert.deepEqual(writes[0], {
      method: 'PUT',
      path: '/versions/3/settings',
      body: {
        expectedGeneration: 4,
        files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
      },
    });
    // The page reloads onto the new revision after a save, and that reload is
    // what puts the draft back in step. Waiting for it here rather than letting
    // it land in the middle of the next subtest.
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Nothing changed yet'),
      'the reload after the save',
    );
  });

  await t.test('a saved revision no build carries says new deployments do not have it', async () => {
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('The current build carries revision 4'),
      'the lagging build message',
    );

    const text = await evaluate('document.body.innerText');
    assert.match(text, /Saved as revision 5\./);
    assert.match(text, /new deployments do not have these changes yet/);
    assert.match(text, /Apply makes a build that does\./);
  });

  await t.test('Discard puts the loaded values back', async () => {
    await typeInto('API_PORT', '3200');
    await waitFor(() => evaluate(`${fieldOf('API_PORT')}.value`), (value) => value === '3200');

    await clickButton('Discard');

    await waitFor(() => evaluate(`${fieldOf('API_PORT')}.value`), (value) => value === '3000', 'the loaded value');
    assert.equal(writes.length, 1, 'discarding sends nothing');
  });

  await t.test('a stale save says somebody else changed them and offers a reload', async () => {
    saveConflict = true;
    await typeInto('API_PORT', '3300');
    await clickButton('Save');
    await waitFor(() => writes.length, (count) => count === 2, 'the refused save');

    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Somebody changed these settings since you loaded them.'),
      'the conflict message',
    );
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Reload')`), true);

    saveConflict = false;
    await clickButton('Reload');
    await waitFor(() => evaluate(`${fieldOf('API_PORT')}.value`), (value) => value === '3000', 'the reloaded values');
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Nothing changed yet'),
      'the reloaded draft',
    );
  });

  await t.test('apply saves what is open first, then says which build new deployments run', async () => {
    await typeInto('API_PORT', '3400');
    await clickButton('Save and apply');
    await waitFor(() => writes.length, (count) => count === 4, 'the save and the apply');

    assert.equal(writes[2].method, 'PUT');
    assert.deepEqual(writes[2].body.files, [
      { path: '.env', entries: [{ key: 'API_PORT', value: '3400' }] },
    ]);
    assert.deepEqual(writes[3], { method: 'POST', path: '/versions/3/settings/apply', body: {} });
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('New deployments run build 3333333333333333333333333333333333333333-r3'),
      'the applied build',
    );
    assert.match(await evaluate('document.body.innerText'), /keep the settings they\s+started with until they are deployed again/);
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Nothing changed yet'),
      'the reload after the apply',
    );
  });

  await t.test('a build holding the slot is named rather than swallowed', async () => {
    applyBusy = true;
    await typeInto('API_PORT', '3500');
    await clickButton('Save and apply');
    await waitFor(() => writes.length, (count) => count === 6, 'the refused apply');

    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('other-version is building.'),
      'the busy message',
    );
    applyBusy = false;
  });

  await t.test('the save that a refused apply followed is not held against the next one', async () => {
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Nothing changed yet'),
      'the reload the refused apply did not skip',
    );

    await typeInto('API_PORT', '3600');
    await clickButton('Save');
    await waitFor(() => writes.length, (count) => count === 7, 'the next save');

    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Nothing changed yet'),
      'the reload after the next save',
    );
    assert.equal(
      (await evaluate('document.body.innerText')).includes('Somebody changed these settings'),
      false,
      'the page saved against its own revision rather than the one it loaded with',
    );
  });

  await t.test('a version with no build yet says why and offers no fields', async () => {
    await call('Page.navigate', { url: `${origin}/#/versions/5/settings` });
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('has no settings yet'),
      'the not ready reason',
    );

    assert.equal(await evaluate(`document.querySelectorAll('input[aria-label], textarea[aria-label]').length`), 0);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save')`), false);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  });

  await t.test('the Versions page opens this page from the card', async () => {
    await call('Page.navigate', { url: `${origin}/#/versions` });
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[aria-label="candidate tested"]'))`));

    await clickButton('Settings', `document.querySelector('input[aria-label="candidate tested"]').closest('article')`);

    await waitFor(() => evaluate('window.location.hash'), (hash) => hash === '#/versions/3/settings', 'the settings route');
    await waitFor(() => evaluate(`Boolean(${fieldOf('API_PORT')})`), Boolean, 'the settings fields');
  });

  // Last, because it needs the page freshly loaded with nothing edited and a
  // build one revision behind, which is the only state where apply goes out on
  // its own and can answer that the build already carries these settings.
  await t.test('an apply that changes nothing says which build already carries the settings', async () => {
    applyReused = true;
    const before = writes.length;

    await clickButton('Save and apply');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the apply on its own');

    assert.deepEqual(writes[before], { method: 'POST', path: '/versions/3/settings/apply', body: {} });
    await waitFor(
      () => evaluate('document.body.innerText'),
      (text) => text.includes('Build 3333333333333333333333333333333333333333-r2 already carries these settings'),
      'the reused build',
    );
    applyReused = false;
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});
