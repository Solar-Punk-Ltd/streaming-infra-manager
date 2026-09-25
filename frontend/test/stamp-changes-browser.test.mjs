/**
 * Topping up and diluting a batch from a deployment's Storage card, all the way
 * through.
 *
 * A real headless Chrome over a real Vite, proxying to a real dev mock manager,
 * so the two dialogs' requests are read by something that applies the
 * manager's own schemas. Runs with the other suites here under
 * `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/stamp-changes-browser.test.mjs`
 * from frontend/. No Bee node and no money: the mock's batches are in its own
 * memory.
 *
 * It works on the pool's 720p rung, which the mock seeds with a full immutable
 * batch that has days left, the shape of the tester's 1080p rung on
 * 2026-09-24. Topping it up buys it a day and diluting it one step leaves it
 * half full with half its life.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { minimumStampAmountPlur, plurToBzzExact } from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import { formatTtl } from '../src/format.ts';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  waitFor,
} from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A cold Vite optimizes the app's dependencies on first load, which can take a while on a busy machine. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

/**
 * Past the mock's two seconds to land a change and the page's ten second
 * reading cadence, with room for a slow machine.
 */
const LANDED_BUDGET_MS = 30_000;

const RUNG = 'abr-pool-1-720p';
const frontend = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const server = createNetServer();
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  await new Promise((done) => {
    server.close(done);
  });
  return port;
}

/** The dev mock manager, on a port of its own, as its own process. */
async function startMockManager(t) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx', '--conditions=development', '--input-type=module',
      '-e', "await import('./dev/mock-manager.mjs'); process.send({ ready: true });",
    ],
    { cwd: frontend, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const bound = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.kill('SIGTERM');
    try {
      await exited;
    } finally {
      clearTimeout(bound);
    }
  });
  await new Promise((done, fail) => {
    const bound = setTimeout(() => finish(new Error('the mock manager did not start')), 20_000);
    const onMessage = (message) => {
      if (message?.ready) finish();
    };
    const onExit = () => finish(new Error('the mock manager exited before it was ready'));
    const finish = (error) => {
      clearTimeout(bound);
      child.off('message', onMessage);
      child.off('exit', onExit);
      error ? fail(error) : done();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  return `http://127.0.0.1:${port}`;
}

/** Records every top-up and dilute the page posts, with its body, before it goes. */
const RECORD_STAMP_WRITES = `(() => {
  window.stampWrites = [];
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const path = String(input);
    if (init?.method === 'POST' && /\\/stamp\\/(topup|dilute)$/.test(path)) {
      window.stampWrites.push({ path, body: JSON.parse(init.body) });
    }
    return send(input, init);
  };
  return true;
})()`;

test('a batch is topped up and diluted from its deployment’s Storage card', async (t) => {
  const manager = await startMockManager(t);
  // Read by vite.config.ts when the config module loads, inside createServer
  // below, so the proxy in front of this Vite is the one the app uses in
  // development. Nothing here stands in for the manager.
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('stamp-changes'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evidence = await evidenceDirectory('stamp-changes-browser-');
  t.diagnostic(`screenshots in ${evidence}`);
  /** Once any dialog has faded all the way in, so the picture is of what the operator reads. */
  const screenshot = async (name) => {
    await waitFor(
      () => evaluate(`(() => {
        const container = document.querySelector('.MuiDialog-container');
        return container ? getComputedStyle(container).opacity : '1';
      })()`),
      (opacity) => opacity === '1',
      'the dialog to finish fading in',
    );
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: true });
    await writeFile(join(evidence, `${name}.png`), Buffer.from(data, 'base64'));
  };

  const body = () => evaluate(PAGE_TEXT);
  const storageText = () => evaluate(`document.getElementById('storage')?.innerText ?? ''`);
  const dialogText = () => evaluate(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  const dialogOpen = () => evaluate(`document.querySelector('[role="dialog"]') !== null`);
  /** A button of the Storage card, which the dialogs are portaled out of. */
  const inStorage = (text) =>
    `[...document.querySelectorAll('#storage button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)})`;
  const inDialog = (text) =>
    `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)})`;
  const click = (finder, description) => clickWhenEnabled(evaluate, finder, description);
  const fill = (value) =>
    fillWhenPresent(evaluate, `document.querySelector('[role="dialog"] input')`, value, 'the dialog’s one input');
  const writes = () => evaluate('window.stampWrites');
  const readBatch = () =>
    evaluate(`fetch('/profiles/${RUNG}/stamp/stamps').then((res) => res.json()).then((answer) => answer.stamps[0])`);
  /** Asks the node again until the card shows what landed, as the operator would with Refresh. */
  const refreshUntil = (landed, description) =>
    waitFor(
      async () => {
        await click(inStorage('Refresh'), 'the Storage card’s Refresh');
        await new Promise((done) => {
          setTimeout(done, 500);
        });
        return landed(await storageText());
      },
      Boolean,
      description,
      LANDED_BUDGET_MS,
    );

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fillWhenPresent(evaluate, `document.querySelector('input[name=username]')`, DEV_USERNAME, 'the username field');
  await fillWhenPresent(evaluate, `document.querySelector('input[name=password]')`, DEV_PASSWORD, 'the password field');
  await click(buttonWithText('Sign in'), 'an enabled Sign in button');
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot');

  await call('Page.navigate', { url: `${origin}/#/deployments/${RUNG}/storage` });
  await waitFor(storageText, (text) => text.includes('100%'), 'the rung’s full batch in its stamps table');
  const batch = await readBatch();
  assert.equal(batch.immutableFlag, true);
  assert.match(await storageText(), /is full, and it cannot overwrite what it holds/);
  assert.match(await storageText(), /Dilute it below to give it room, which keeps the batch, or buy a new one/);
  assert.match(await storageText(), new RegExp(`${batch.utilization} of ${batch.utilization}`), 'the Used column names the chunks in the fullest bucket');
  // A laptop's card is narrower than the table's readings, and a control past
  // its right edge is one the operator has to find by scrolling the table.
  const offTheCard = await evaluate(`(() => {
    const table = document.querySelector('#storage table').parentElement.getBoundingClientRect();
    return ['Top up', 'Dilute'].filter((text) => {
      const button = [...document.querySelectorAll('#storage button')].find((b) => b.textContent.trim() === text);
      const box = button?.getBoundingClientRect();
      return !box || box.width === 0 || box.right > table.right;
    });
  })()`);
  assert.deepEqual(offTheCard, [], 'the row’s actions are in view without scrolling the table');
  await screenshot('full-batch');
  assert.equal(await evaluate(RECORD_STAMP_WRITES), true);

  // Top up by a day at the mock's price.
  const price = (await evaluate(`fetch('/profiles/${RUNG}/stamp/chainstate').then((res) => res.json())`)).currentPrice;
  const oneDay = minimumStampAmountPlur(price);
  const cost = plurToBzzExact(BigInt(oneDay) * 2n ** BigInt(batch.depth));
  await click(inStorage('Top up'), 'the row’s Top up button');
  await waitFor(dialogText, (text) => text.includes('Top up batch'), 'the top-up dialog');
  assert.match(await dialogText(), new RegExp(`A day more costs ${oneDay} a chunk`));
  await fill(oneDay);
  await waitFor(dialogText, (text) => text.includes(`Top up for ${cost} BZZ`), 'the confirm to name the cost');
  assert.match(await dialogText(), /Adds, at today’s price\s+1d 0h/);
  await screenshot('top-up-dialog');
  await click(inDialog(`Top up for ${cost} BZZ`), 'the enabled top-up confirm');
  await waitFor(dialogOpen, (open) => open === false, 'the top-up dialog to close once bee answered');
  await waitFor(storageText, (text) => text.includes('Bee sent the top-up of batch'), 'the card to say the top-up was sent');
  assert.match(await storageText(), /The new life shows here once the node has read it back from the chain/);
  assert.deepEqual(await writes(), [
    { path: `/profiles/${RUNG}/stamp/topup`, body: { batch_id: batch.batchID, amount: oneDay } },
  ]);
  const toppedUp = await waitFor(
    readBatch,
    (read) => read.batchTTL === batch.batchTTL + 86_400,
    'the day to land on the batch',
    LANDED_BUDGET_MS,
  );
  await refreshUntil((text) => text.includes(formatTtl(toppedUp.batchTTL)), 'the table to show the new life');

  // Dilute one step, which is what gives a full immutable batch room again.
  await click(inStorage('Dilute'), 'the row’s Dilute button');
  await waitFor(dialogText, (text) => text.includes('Dilute batch'), 'the dilute dialog');
  const next = batch.depth + 1;
  await waitFor(dialogText, (text) => text.includes(`Dilute to depth ${next}`), 'the confirm to name the depth it starts at');
  assert.match(await dialogText(), /Full after\s+50%/);
  assert.match(await dialogText(), /No BZZ, only the transaction fee in xDAI/);
  await screenshot('dilute-dialog');
  await click(inDialog(`Dilute to depth ${next}`), 'the enabled dilute confirm');
  await waitFor(dialogOpen, (open) => open === false, 'the dilute dialog to close once bee answered');
  await waitFor(storageText, (text) => text.includes('Bee sent the dilution of batch'), 'the card to say the dilute was sent');
  assert.deepEqual((await writes())[1], {
    path: `/profiles/${RUNG}/stamp/dilute`,
    body: { batch_id: batch.batchID, depth: next },
  });
  const diluted = await waitFor(readBatch, (read) => read.depth === next, 'the new depth to land on the batch', LANDED_BUDGET_MS);
  assert.equal(diluted.batchTTL, Math.floor(toppedUp.batchTTL / 2));
  await refreshUntil(
    (text) => text.includes(formatTtl(diluted.batchTTL)) && !text.includes('is full, and it cannot overwrite'),
    'the table to show the diluted batch and the full alert to go',
  );
  assert.match(await storageText(), new RegExp(`50%\\s*${batch.utilization} of ${batch.utilization * 2}`));
  // Half its life is under two days, so the card now warns it runs out, and
  // offers the top-up that buys that life back.
  assert.match(
    await storageText(),
    new RegExp(`runs out in ${formatTtl(diluted.batchTTL)}\\. Top it up below, or buy the next one, before it does`),
  );
  await screenshot('after');
});
