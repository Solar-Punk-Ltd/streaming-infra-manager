import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

import { launchChrome, PAGE_TEXT, waitFor } from './support/chrome.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../../common/src/index.ts', import.meta.url));
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function reading(state, initialAgeMs = 0) {
  return {
    state: 'available',
    streams: [{ adminId: ADMIN_ID, runNumber: 4, state, initialAgeMs }],
  };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the actual lifecycle hook expires, sequences and detaches browser polls', async (t) => {
  const plans = [];
  const requests = [];
  const enqueue = (name, body, held = false) => plans.push({ name, body, held });
  const server = await createServer({
    root: frontend,
    configFile: false,
    cacheDir: viteCacheFor('uploader-lifecycle'),
    resolve: { alias: { '@streaming-infra-manager/common': common } },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [
      react(),
      {
        name: 'uploader-lifecycle-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            const path = req.url?.split('?')[0] ?? '';
            const match = path.match(/^\/profiles\/([^/]+)\/uploader-lifecycle$/);
            if (!match) return next();
            const name = decodeURIComponent(match[1]);
            const planIndex = plans.findIndex((candidate) => candidate.name === name);
            const plan = planIndex === -1 ? undefined : plans.splice(planIndex, 1)[0];
            const request = {
              name,
              plannedState: plan?.body?.streams?.[0]?.state ?? null,
              closed: false,
              reply() {
                if (res.writableEnded || res.destroyed || !plan) return;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(plan.body));
              },
            };
            res.on('close', () => {
              if (!res.writableEnded) request.closed = true;
            });
            requests.push(request);
            if (plan && !plan.held) request.reply();
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const body = () => evaluate(PAGE_TEXT);
  const select = (name, instanceId) =>
    evaluate(`window.lifecycleTest.select(${JSON.stringify(name)}, ${JSON.stringify(instanceId)})`);

  enqueue('alpha', reading('waiting'));
  enqueue('alpha', reading('waiting'), true);
  enqueue('alpha', reading('closed'));
  await call('Page.navigate', { url: `${origin}/test/fixtures/lifecycle/` });

  await waitFor(body, (text) => text.includes('Waiting for stream to resume'), 'fresh waiting state');
  await waitFor(
    () => requests.filter((request) => request.name === 'alpha').length,
    (count) => count >= 2,
    'the next delayed lifecycle poll',
    1_500,
  );
  assert.match(await body(), /Admin console link is not configured/);
  await waitFor(
    body,
    (text) => text.includes('Finishing recording'),
    'later closed state',
  ).catch((error) => {
    throw new Error(
      `${error.message}. Requests: ${JSON.stringify(requests.map(({ name, plannedState, closed }) => ({ name, plannedState, closed })))}. Browser errors: ${JSON.stringify(browser.errors)}.`,
    );
  });
  const slowWaiting = requests[1];
  assert.ok(slowWaiting, 'the earlier waiting request is still held');
  slowWaiting.reply();
  await delay(100);
  assert.match(await body(), /Finishing recording/);
  assert.doesNotMatch(await body(), /Waiting for stream to resume/);

  await delay(450);
  assert.match(await body(), /Finishing recording/, 'terminal facts do not expire');

  enqueue('beta', reading('waiting'), true);
  await select('beta', 'beta-1');
  await waitFor(
    body,
    (text) => text.includes('Broadcast status unavailable') && !text.includes('Finishing recording'),
    'old deployment state to disappear before the new response',
  );
  await waitFor(
    () => requests.filter((request) => request.name === 'beta').length,
    (count) => count === 1,
    'the held beta request',
  );
  const oldName = requests.find((request) => request.name === 'beta');
  assert.ok(oldName, 'the beta request is held');

  enqueue('gamma', reading('vod'));
  await select('gamma', 'gamma-1');
  await waitFor(body, (text) => text.includes('Completed replay available'), 'new deployment VOD state');
  oldName.reply();
  await delay(100);
  assert.match(await body(), /Completed replay available/);

  const gammaRequestsBeforeReplacement = requests.filter(
    (request) => request.name === 'gamma',
  ).length;
  enqueue('gamma', reading('waiting'), true);
  await select('gamma', 'gamma-2');
  await waitFor(
    () => requests.filter((request) => request.name === 'gamma').length,
    (count) => count > gammaRequestsBeforeReplacement,
    'the old instance request',
  );
  const oldInstance = requests.filter((request) => request.name === 'gamma').at(-1);
  assert.ok(oldInstance, 'the old instance request is held');
  enqueue('gamma', reading('closed'));
  await select('gamma', 'gamma-3');
  await waitFor(body, (text) => text.includes('Finishing recording'), 'replacement instance state');
  oldInstance.reply();
  await delay(100);
  assert.match(await body(), /Finishing recording/);

  await evaluate("window.lifecycleTest.setAdminConsoleUrl('https://admin.example.test/console')");
  await waitFor(
    () => evaluate("document.querySelector('a')?.href ?? ''"),
    (href) => href === `https://admin.example.test/console/#/streams/${ADMIN_ID}`,
    'validated public admin console link',
  );
  assert.match(
    await body(),
    /Deployment controls only start, stop, or restart infrastructure/,
  );

  enqueue('delta', reading('live', 250));
  enqueue('delta', reading('live', 250), true);
  await select('delta', 'delta-1');
  await waitFor(body, (text) => /\bLive\b/.test(text), 'fresh active state');
  await waitFor(body, (text) => text.includes('Broadcast status unavailable'), 'active state to expire while the next poll hangs');

  enqueue('epsilon', reading('waiting'), true);
  await select('epsilon', 'epsilon-1');
  await waitFor(
    () => requests.filter((request) => request.name === 'epsilon').length,
    (count) => count === 1,
    'request owned by the mounted hook',
  );
  const unmountedRequest = requests.find((request) => request.name === 'epsilon');
  await evaluate('window.lifecycleTest.unmount()');
  await waitFor(body, (text) => text.includes('Lifecycle test unmounted'), 'hook component to unmount');
  await waitFor(() => unmountedRequest.closed, Boolean, 'unmounted request to be aborted');

  enqueue('zeta', reading('live'), true);
  await evaluate('window.lifecycleTest.setPollingPolicy(1000, 400)');
  await select('zeta', 'zeta-1');
  await waitFor(
    () => requests.filter((request) => request.name === 'zeta').length,
    (count) => count === 1,
    'delayed latest response',
  );
  const delayedLatest = requests.find((request) => request.name === 'zeta');
  await delay(450);
  delayedLatest.reply();
  await waitFor(
    body,
    (text) => text.includes('Broadcast status unavailable'),
    'response older than the active freshness window to remain unavailable',
  );
  assert.doesNotMatch(await body(), /\bLive\b/);
});
