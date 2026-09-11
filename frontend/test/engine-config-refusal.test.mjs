/**
 * That a refused config file apply says so where the operator is looking.
 *
 * Measured on 2026-09-11 against a real manager: the manager answered 409 with
 * its reason, the dialog rendered that reason below a config file taller than
 * the dialog, and nothing scrolled to it. The button looked like it had done
 * nothing at all.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchChrome, PAGE_TEXT, pointToClick, waitFor } from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const REFUSAL = 'config-stage has an unresolved deploy attempt. Its container snapshot cannot be captured yet.';
/** Long enough that the dialog scrolls, which is every real engine config. */
const TEMPLATE = ['listen        RTMP_PORT_PLACEHOLDER;', ...Array.from({ length: 90 }, (_, line) => `# stack line ${line}`)].join('\n');

const profile = {
  name: 'config-stage', kind: 'streamer', status: 'RUNNING', port_slot: 1, host: 'localhost',
  notes: null, last_error: null, last_error_at: null,
  created_at: '2026-09-11T06:51:00Z', updated_at: '2026-09-11T06:58:00Z',
  engine_settings: {}, has_engine_config: false, engine_config_error: null, engine_config_state: null,
  stamp_id: null, public_key: '1'.repeat(40), pendingStamp: false,
  containers: [{ service: 'srs', ports: {} }],
};

test('a refused config file apply shows its reason without scrolling for it', async (t) => {
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('engine-config-refusal'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-engine-config-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
          if (path === '/auth/session') return json({ username: 'config-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
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
          if (path === '/profiles/config-stage/engine-config') {
            if (req.method === 'PUT') return json({ error: 'deploy_attempt_refused', name: profile.name, message: REFUSAL }, 409);
            return json({ engine: 'srs', supported: true, unsupportedReason: null, config: null, template: TEMPLATE,
              placeholders: ['RTMP_PORT_PLACEHOLDER'], state: null, error: null, references: [] });
          }
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
  const dialog = `document.querySelector('[role="dialog"]')`;
  const click = async (name, scope = 'document') => {
    const point = await pointToClick(evaluate, `[...((${scope})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(name)})`, `an enabled ${name} button`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };

  await call('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/#/deployments/config-stage` });
  await waitFor(() => evaluate(PAGE_TEXT), text => text.includes('Config file'), 'the deployment page');
  await click('Config file');
  // The dialog opens before its config file arrives, so wait for the editor
  // itself rather than for the frame around it.
  await waitFor(() => evaluate(`!!${dialog}?.querySelector('textarea')`), Boolean, 'the config file editor');

  // An edit through the field's own setter, the way typing reaches React.
  await evaluate(`(() => {
    const area = ${dialog}.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, '# edited by the suite\\n' + area.value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('Check and apply', dialog);

  await waitFor(() => evaluate(`(() => {
    const alert = [...${dialog}.querySelectorAll('.MuiAlert-root')].find(node => node.textContent.includes(${JSON.stringify(REFUSAL)}));
    if (!alert) return null;
    const box = alert.getBoundingClientRect();
    const view = ${dialog}.querySelector('.MuiDialogContent-root').getBoundingClientRect();
    return { top: Math.round(box.top - view.top), bottom: Math.round(box.bottom - view.bottom), height: Math.round(view.height) };
  })()`), seen => seen !== null, 'the refusal the manager sent');

  const placed = await evaluate(`(() => {
    const alert = [...${dialog}.querySelectorAll('.MuiAlert-root')].find(node => node.textContent.includes(${JSON.stringify(REFUSAL)}));
    const box = alert.getBoundingClientRect();
    const view = ${dialog}.querySelector('.MuiDialogContent-root').getBoundingClientRect();
    return { above: Math.round(view.top - box.top), below: Math.round(box.bottom - view.bottom) };
  })()`);
  assert.ok(placed.above <= 0, `the reason sits ${placed.above} pixels above what the dialog shows`);
  assert.ok(placed.below <= 0, `the reason sits ${placed.below} pixels below what the dialog shows`);
  await call('Emulation.clearDeviceMetricsOverride');
});
