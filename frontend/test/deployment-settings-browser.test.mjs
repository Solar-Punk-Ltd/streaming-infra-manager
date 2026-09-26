/**
 * A deployment's own settings, edited from its page, in a real Chrome.
 *
 * Levi ruled on 2026-09-25 that every setting a deployment reads is editable
 * for that deployment, with the version's value as the default, and okayed a
 * warning when the running containers are behind on what was saved. This
 * drives the card through what an operator meets: sections folded until a
 * search or a click opens them, a field shaped by what the key takes, a secret
 * that is never shown, keys a control of the deployment decides, a key the
 * version dropped, a value the manager would refuse, a save that sends only
 * what changed with the revision the page read, a reset, a save that lost a
 * race, the banner and its Apply, a stopped deployment, and a version with no
 * build yet. The deployment's engine settings are in the same list since Levi
 * ruled the Engine card's drawer out on 2026-09-26, so it also drives those as
 * the drawer showed them, a pair the engine would refuse, a saved segment
 * length that Apply recreates the engine and the uploader for, the Engine card
 * marking a saved value the engine does not run yet, and stored engine
 * settings the next deploy would refuse. All of it at a phone's width, because
 * that is where an operator reads a page during an incident.
 *
 * A real headless Chrome over a real Vite, with an offline fixture in place of
 * the manager. Runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`,
 * or on its own: `node --import tsx --conditions=development --test test/deployment-settings-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import { engineSettingFieldOf } from '@streaming-infra-manager/common';

import {
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  paintedInView,
  readWhenPresent,
  stillWithin,
  waitFor,
} from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';
import {
  afterApply,
  afterSave,
  CEILING_UNDER_STORED_SEGMENT,
  REFUSED_ENGINE_INSTANCE,
  refusedEngineCatalog,
  RUNNING_INSTANCE,
  runningCatalog,
  STOPPED_INSTANCE,
  stoppedCatalog,
  UNRECORDED_INSTANCE,
  unrecordedCatalog,
} from './fixtures/deploymentSettings.mjs';
import { srsOverviewOf } from './fixtures/engineOverview.mjs';

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** What the host's base `.env` sets, which the settings list names as the segment length's default. */
const HOST_ENV = { HLS_FRAGMENT: '2' };

/** Whether the drawer the Engine card used to open is on screen, which it never is since the drawer went. */
const ENGINE_DRAWER_OPEN = `[...document.querySelectorAll('h2')].some(heading => heading.textContent.startsWith('Engine settings for'))`;

const NARROW = 390;
const WIDE = 1280;

const RUNNING = 'settings-stage';
const STOPPED = 'parked-stage';
const NOT_READY = 'fresh-stage';
const UNRECORDED = 'early-stage';
const REFUSED_ENGINE = 'stuck-stage';

const RUNNING_SRS = [{ service: 'srs', ports: {} }, { service: 'stream-uploader', ports: {} }, { service: 'bee-uploader', ports: {} }];

function profileNamed(name, instanceId, status, engineSettings = {}) {
  return {
    name, kind: 'streamer', status, port_slot: 1, host: 'localhost',
    instance_id: instanceId, engine_config_revision: 0, intent_revision: 0,
    stack_version_id: 1, engine_config_state: null, engine_config_error: null, has_engine_config: false,
    notes: null, notes_revision: 0, last_error: null, last_error_at: null, has_srt_passphrase: false,
    created_at: '2026-09-26T08:00:00.000Z', updated_at: '2026-09-26T08:00:00.000Z',
    engine_settings: engineSettings, stamp_id: null, public_key: '1'.repeat(40), pendingStamp: false,
    containers: status === 'RUNNING' ? RUNNING_SRS : [],
  };
}

const PROFILES = [
  profileNamed(RUNNING, RUNNING_INSTANCE, 'RUNNING'),
  profileNamed(STOPPED, STOPPED_INSTANCE, 'STOPPED'),
  profileNamed(NOT_READY, '66666666-6666-4666-8666-666666666666', 'RUNNING'),
  profileNamed(UNRECORDED, UNRECORDED_INSTANCE, 'RUNNING'),
  profileNamed(REFUSED_ENGINE, REFUSED_ENGINE_INSTANCE, 'RUNNING', { HLS_FRAGMENT: '3' }),
];

/**
 * The deployment's row after a save of its settings, as the manager keeps it:
 * each engine key in its engine settings, and the row moved, which is what a
 * read of the deployments list finds.
 */
function storeEngineSettings(name, entries) {
  const profile = PROFILES.find((row) => row.name === name);
  if (!profile) return;
  for (const { key, value } of entries) {
    if (!engineSettingFieldOf(key)) continue;
    if (value === null) delete profile.engine_settings[key];
    else profile.engine_settings[key] = value;
  }
  profile.updated_at = new Date().toISOString();
}

/** The sentence the fixture's manager refuses a staged save with, as `settingEditProblems` words one. */
const STAGED_REFUSAL = 'ADMIN_API_URL is stored for this deployment, but its version no longer declares it. Reset it rather than set it.';

test('a deployment settings card lists, edits, saves and applies at a phone width', { timeout: 240_000 }, async (t) => {
  const catalogs = new Map([
    [RUNNING, runningCatalog()],
    [STOPPED, stoppedCatalog()],
    [UNRECORDED, unrecordedCatalog()],
    [REFUSED_ENGINE, refusedEngineCatalog()],
  ]);
  const writes = [];
  const stage = { refuseSave: false, applyBusy: false };

  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('deployment-settings'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{
      name: 'offline-deployment-settings-fixture',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0] ?? '';
          const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
          if (!/^\/(auth|profiles|groups|config|events|metrics|versions)(\/|$)/.test(path)) return next();
          if (path === '/auth/session') return json({ username: 'settings-review', isAdmin: true, expiresAt: '2099-01-01T00:00:00Z' });
          if (path === '/profiles') return json({ profiles: PROFILES });
          if (path === '/groups') return json({ groups: [] });
          if (path === '/versions') return json([]);
          if (path === '/versions/attempts') return json({ attempts: [] });
          if (path === '/config') return json({ host: 'offline.example', srtPassphrase: null, chequebookFloorBzz: '0.5' });
          if (path === '/events' || path.startsWith('/metrics')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': offline fixture\n\n');
            return;
          }

          const settings = /^\/profiles\/([^/]+)\/settings(\/apply)?$/.exec(path);
          if (settings) {
            const [, name, apply] = settings;
            if (name === NOT_READY) {
              return json({ error: 'settings_not_ready', name: 'candidate', message: 'candidate has no settings yet. Its first build has not finished.' }, 409);
            }
            const catalog = catalogs.get(name);
            if (!catalog) return json({ error: 'profile_not_found', name }, 404);
            if (req.method === 'GET' && !apply) return json(catalog);

            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            writes.push({ method: req.method, path, body });

            if (apply) {
              if (stage.applyBusy) return json({ error: 'profile_busy', name, status: 'DEPLOYING' }, 409);
              // The manager's own refusal: its deploy would refuse the stored engine settings.
              if (catalog.engineSettingsProblem) return json({ error: 'validation_error', errors: [catalog.engineSettingsProblem], name }, 400);
              const applied = afterApply(catalog);
              catalogs.set(name, applied.catalog);
              return json({ recreated: applied.recreated }, 202);
            }
            if (stage.refuseSave) return json({ error: 'validation_error', errors: [STAGED_REFUSAL], name }, 400);
            // The manager's own check, not a staged one: a save naming a
            // revision the settings have moved past is what it refuses.
            if (body.expectedRevision !== catalog.revision || body.expectedInstanceId !== catalog.instanceId) {
              return json({ error: 'deployment_settings_changed', name, message: "This deployment's settings changed after the page read them. Reload them and make the change again." }, 409);
            }
            const saved = afterSave(catalog, body.entries);
            catalogs.set(name, saved);
            storeEngineSettings(name, body.entries);
            return json({ revision: saved.revision });
          }
          const engine = /^\/profiles\/([^/]+)\/engine$/.exec(path);
          const engineOf = PROFILES.find((row) => row.name === engine?.[1]);
          if (engineOf) return json(srsOverviewOf(engineOf, { hostEnv: HOST_ENV }));
          // Every other read of a deployment is a node that does not answer,
          // which the rest of the page already knows how to show.
          if (path.startsWith('/profiles/')) return json({ error: 'Node unavailable', code: 'bee_node_unreachable' }, 503);
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
  const evidence = await evidenceDirectory('deployment-settings-browser-');

  const body = () => evaluate(PAGE_TEXT);
  const shows = (description, ...texts) => waitFor(body, (text) => texts.every((part) => text.includes(part)), description);
  const card = `document.getElementById('stack-settings')`;
  const cardText = () => evaluate(`${card}?.innerText ?? ''`);
  const engineCard = `[...document.querySelectorAll('h3')].find(el => el.textContent.trim() === 'SRS 6')?.closest('.MuiPaper-root')`;
  const engineCardText = () => evaluate(`(${engineCard})?.innerText ?? ''`);
  const rowOf = (key) => `document.querySelector('li[data-setting="${key}"]')`;
  const fieldOf = (key) => `document.getElementById('deployment-setting-${key}')`;
  // What a screen reader is told about a field: the name and the description
  // Chrome itself works out, rather than the attributes they come from.
  const accessible = async (key) => {
    const { root } = await call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: `#deployment-setting-${key}` });
    const { nodes } = await call('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    return { name: nodes[0]?.name?.value ?? '', description: nodes[0]?.description?.value ?? '' };
  };
  const rowText = (key) => readWhenPresent(evaluate, rowOf(key), 'innerText', `the ${key} row`);
  const buttonIn = (scope, label) => `[...((${scope})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  const saveDisabled = () => readWhenPresent(evaluate, buttonIn(card, 'Save'), 'disabled', 'the Save button');
  const typeInto = (key, value) => fillWhenPresent(evaluate, fieldOf(key), value, `the ${key} field`);
  const choose = (key, value) => waitFor(() => evaluate(`(() => {
    const field = ${fieldOf(key)};
    if (!field || field.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`), Boolean, `the ${key} list`);
  const search = (text) => fillWhenPresent(evaluate, `document.querySelector('input[aria-label="Search settings"]')`, text, 'the search field');
  const openEverySection = () => evaluate(`[...document.querySelectorAll('#stack-settings h4 button')]
    .filter(button => button.getAttribute('aria-expanded') === 'false')
    .forEach(button => button.click())`);
  // The viewport alone. A capture beyond the viewport lays the page out again
  // at its whole height and paints the open folds over each other, which
  // reads as a broken card when it is not.
  const capture = async (name) => {
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(join(evidence, name), Buffer.from(data, 'base64'));
  };
  const screenshot = async (name, at = card, block = 'start') => {
    await evaluate(`(${at})?.scrollIntoView({ block: ${JSON.stringify(block)} })`);
    await capture(name);
  };
  const openDeployment = async (name) => {
    await call('Page.navigate', { url: `${origin}/#/deployments/${name}` });
    await shows(`the ${name} page with its settings card`, 'Stack settings');
  };

  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });
  await openDeployment(RUNNING);

  await t.test('the card sits after the Engine card and opens folded, with the banner naming what is behind', async () => {
    await waitFor(cardText, (text) => text.includes('1 setting is behind the running containers'), 'the drift banner');
    const headings = await evaluate(`[...document.querySelectorAll('h3')].map(el => el.textContent.trim())`);
    assert.ok(headings.indexOf('SRS 6') >= 0, headings.join(' | '));
    assert.equal(headings.indexOf('Stack settings'), headings.indexOf('SRS 6') + 1, headings.join(' | '));

    const text = await cardText();
    assert.match(text, /1 setting is behind the running containers: LOG_LEVEL\. Apply recreates stream-uploader\./);
    assert.equal(await evaluate(`Boolean(${buttonIn(card, 'Apply')})`), true);
    assert.equal(await evaluate(`${card}.querySelectorAll('li[data-setting]').length`), 0, 'every section starts folded');
    assert.match(text, /Engine settings\s+4 settings/);
    assert.match(text, /Stream Uploader\s+4 settings/);
    assert.match(text, /Logging\s+1 setting, 1 not applied/);
    assert.match(text, /No longer declared by this version\s+1 setting/);
    await screenshot('folded-phone.png');
  });

  await t.test('a search opens the sections it matches and keeps only the matching keys', async () => {
    await search('startup checks');
    await waitFor(() => evaluate(`Boolean(${rowOf('UPLOADER_START_GATES')})`), Boolean, 'the matching key');
    assert.equal(await evaluate(`${card}.querySelectorAll('li[data-setting]').length`), 1);

    await search('no such setting');
    await waitFor(cardText, (text) => text.includes('No setting matches "no such setting".'), 'the empty search');

    await search('');
    await waitFor(() => evaluate(`${card}.querySelectorAll('li[data-setting]').length`), (count) => count === 0, 'the sections folded again');
  });

  await t.test('each key gets the field its shape takes, and the default beside it', async () => {
    await openEverySection();
    await waitFor(() => evaluate(`${card}.querySelectorAll('li[data-setting]').length`), (count) => count === 15, 'every key on screen');

    assert.equal(await evaluate(`${fieldOf('UPLOADER_START_GATES')}.tagName`), 'SELECT');
    assert.deepEqual(
      await evaluate(`[...${fieldOf('UPLOADER_START_GATES')}.options].map(option => option.value)`),
      ['', 'chequebook-warn', 'warn', 'refuse'],
    );
    assert.equal(await evaluate(`${fieldOf('BEE_UPLOADER_FULL_NODE')}.type`), 'checkbox');
    assert.equal(await evaluate(`${fieldOf('MAX_QUEUE_SIZE')}.inputMode`), 'numeric');
    assert.equal(await evaluate(`${fieldOf('MAX_QUEUE_SIZE')}.value`), '250');
    assert.equal(await evaluate(`${fieldOf('CHEQUEBOOK_MIN_BZZ')}.inputMode`), 'decimal');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_URL')}.type`), 'text');

    assert.match(await rowText('MAX_QUEUE_SIZE'), /Default: 100/);
    assert.match(await rowText('MAX_QUEUE_SIZE'), /A whole number, 1 or more\./);
    assert.match(await rowText('CHEQUEBOOK_MIN_BZZ'), /A number from 0 to 1000\. Use a period for decimals\./);
    assert.match(await rowText('MAX_QUEUE_SIZE'), /set here/);
    assert.equal(await evaluate(`Boolean(${buttonIn(rowOf('MAX_QUEUE_SIZE'), 'Reset to default')})`), true);
    assert.equal(await evaluate(`Boolean(${buttonIn(rowOf('UPLOADER_START_GATES'), 'Reset to default')})`), false, 'nothing is stored to reset');
  });

  await t.test('a secret is never shown, only whether one is stored, in a masked field', async () => {
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.type`), 'password');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.value`), '');
    // Browsers ignore `off` on a password field, so only `new-password` keeps a saved sign-in out of a secret.
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.getAttribute('autocomplete')`), 'new-password');
    assert.equal(await evaluate(`${fieldOf('MAX_QUEUE_SIZE')}.getAttribute('autocomplete')`), 'off');
    assert.match(await rowText('ADMIN_API_TOKEN'), /A value is stored for this deployment\. It is never shown\./);
    assert.match(await rowText('API_AUTH_TOKEN'), /The manager generated a value for this deployment\./);
    assert.equal(await evaluate(`${fieldOf('API_AUTH_TOKEN')}.type`), 'password');
  });

  await t.test('a key a control decides shows its value, names the control and takes no input', async () => {
    const text = await rowText('BEE_URL');
    assert.match(text, /http:\/\/bee-uploader:1633/);
    assert.match(text, /Decided by the deployment's Bee URL\. It cannot be set here\./);
    assert.equal(await evaluate(`${rowOf('BEE_URL')}.querySelectorAll('input, select, textarea').length`), 0);
  });

  await t.test('an engine setting the deployment does not read says who reads it and takes no input', async () => {
    assert.match(await rowText('ABR_FPS'), /Only a deployment that encodes the ABR ladder reads it, so it cannot be set here\./);
    assert.equal(await evaluate(`${rowOf('ABR_FPS')}.querySelectorAll('input, select, textarea').length`), 0);
  });

  await t.test('the engine settings come first, each by its label with the key beside it, its unit, its help and its default', async () => {
    const folds = await evaluate(`[...document.querySelectorAll('#stack-settings h4')].map(heading => heading.textContent)`);
    assert.match(folds[0] ?? '', /^Engine settings/);

    const fragment = await rowText('HLS_FRAGMENT');
    assert.match(fragment, /^Segment length\s+HLS_FRAGMENT/);
    assert.match(fragment, /The shortest a piece of the stream may be/);
    assert.match(fragment, /seconds/);
    assert.match(fragment, /A number of seconds from 0\.5 to 30\. Use a period for decimals\./);
    assert.match(fragment, /Default: 2 seconds, set on this host/);
    assert.equal(await evaluate(`${fieldOf('HLS_FRAGMENT')}.value`), '2');
    assert.equal(await evaluate(`${fieldOf('HLS_FRAGMENT')}.inputMode`), 'decimal');
    assert.match(await rowText('SRT_LATENCY'), /Default: 2000 milliseconds, the manager's own/);
    assert.equal(await evaluate(`${fieldOf('SRT_LATENCY')}.inputMode`), 'numeric');
    assert.match(await rowText('HLS_WINDOW'), /This version's config does not read this setting, so a value here has no effect on this version\./);
  });

  await t.test('an engine field is named by its label and its key, and says its unit and bounds', async () => {
    assert.deepEqual(await accessible('HLS_FRAGMENT'), {
      name: 'Segment length HLS_FRAGMENT',
      description: 'A number of seconds from 0.5 to 30. Use a period for decimals.',
    });
    assert.deepEqual(await accessible('SRT_LATENCY'), {
      name: 'SRT latency SRT_LATENCY',
      description: 'A whole number of milliseconds from 20 to 10000.',
    });
  });

  await t.test('a key the version no longer declares is listed with only a reset', async () => {
    assert.match(await rowText('OLD_UPLOAD_RETRIES'), /no longer declares this key/);
    assert.equal(await evaluate(`${rowOf('OLD_UPLOAD_RETRIES')}.querySelectorAll('input, select, textarea').length`), 0);
    assert.deepEqual(
      await evaluate(`[...${rowOf('OLD_UPLOAD_RETRIES')}.querySelectorAll('button')].map(button => button.textContent.trim())`),
      ['Reset'],
    );
  });

  await t.test('a long description opens on its first words and unfolds on request', async () => {
    assert.match(await rowText('ADMIN_API_URL'), /…/);
    assert.doesNotMatch(await rowText('ADMIN_API_URL'), /mints the feed topic and the publish key/);
    await clickWhenEnabled(evaluate, buttonIn(rowOf('ADMIN_API_URL'), 'More'), 'the More button');
    await waitFor(() => rowText('ADMIN_API_URL'), (text) => text.includes('mints the feed topic and the publish key'), 'the whole description');
  });

  await t.test('the open card fits a phone with no sideways scroll', async () => {
    const measurement = await evaluate(`(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      outside: [...document.querySelectorAll('#stack-settings input, #stack-settings select, #stack-settings button')]
        .filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); })
        .map(el => el.getAttribute('aria-label') ?? el.textContent.trim()),
    }))()`);
    assert.equal(measurement.width, NARROW);
    assert.ok(measurement.scrollWidth <= NARROW, `page width ${measurement.scrollWidth} exceeds ${NARROW}`);
    assert.deepEqual(measurement.outside, []);
  });

  // A fold grows to its keys over a short animation, so this waits for it to
  // settle. One that stays shorter than its keys is drawn under the next
  // section's heading, which no text read can see.
  await t.test('every open section settles at the height of its keys, so none is drawn over the next', async () => {
    const folds = await waitFor(
      () => evaluate(`[...document.querySelectorAll('#stack-settings .MuiCollapse-root')].map(fold => ({
        fold: Math.round(fold.getBoundingClientRect().height),
        keys: Math.round(fold.querySelector('ul')?.getBoundingClientRect().height ?? 0),
      }))`),
      (found) => found.length === 8 && found.every(({ fold, keys }) => keys > 0 && fold >= keys - 1),
      'every fold at the height of its keys',
    );
    assert.equal(folds.length, 8);
    await screenshot('open-phone.png');
  });

  await t.test('a value the manager would refuse is named under its field and stops the save', async () => {
    await typeInto('MAX_QUEUE_SIZE', '0');
    await waitFor(() => rowText('MAX_QUEUE_SIZE'), (text) => text.includes('MAX_QUEUE_SIZE must be at least 1. Got 0.'), 'the refusal under the field');
    await waitFor(saveDisabled, (off) => off === true, 'a Save that stops at the refused value');
    assert.match(await cardText(), /One value cannot be saved as written: MAX_QUEUE_SIZE/);
    assert.equal(writes.length, 0, 'nothing went to the manager');

    await typeInto('MAX_QUEUE_SIZE', '250');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the footer back at rest');
  });

  await t.test('an engine value the engine would refuse is named under its field in its own words, and read out', async () => {
    await typeInto('HLS_FRAGMENT', '0.1');
    await waitFor(() => rowText('HLS_FRAGMENT'), (text) => text.includes('Segment length must be at least 0.5. Got 0.1.'), 'the refusal under the field');
    await waitFor(saveDisabled, (off) => off === true, 'a Save that stops at the refused value');
    assert.match(await cardText(), /One value cannot be saved as written: HLS_FRAGMENT/);
    assert.equal((await accessible('HLS_FRAGMENT')).description, 'Segment length must be at least 0.5. Got 0.1.');
    assert.equal(
      await evaluate(`document.getElementById('deployment-setting-HLS_FRAGMENT-helper-text')?.getAttribute('aria-live')`),
      'polite',
      'the line under the field is a live region, so the refusal is read out as it appears',
    );

    await typeInto('HLS_FRAGMENT', '2');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the footer back at rest');
  });

  await t.test('a pair the engine would refuse is named once above Save, which stays off until the pair is whole', async () => {
    const pair = 'The force-close ceiling of 2.5 seconds is below the segment length of 3 seconds';
    await typeInto('HLS_FRAGMENT', '3');
    await waitFor(cardText, (text) => text.includes(pair), 'the pair refused above Save');
    assert.equal((await cardText()).split(pair).length - 1, 1, 'the sentence is said once');
    assert.equal(await saveDisabled(), true);
    assert.equal(writes.length, 0, 'nothing went to the manager');
    await screenshot('engine-pair-phone.png', buttonIn(card, 'Save'), 'end');

    await typeInto('HLS_SEGMENT_MAX', '4');
    await waitFor(cardText, (text) => !text.includes('force-close ceiling'), 'the pair whole again');
    await waitFor(saveDisabled, (off) => off === false, 'Save back on');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Discard'), 'the Discard button');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the discarded draft');
  });

  await t.test('a changed key is marked with what applying it recreates', async () => {
    await choose('UPLOADER_START_GATES', 'refuse');
    await waitFor(() => rowText('UPLOADER_START_GATES'), (text) => text.includes('unsaved') && text.includes('recreates stream-uploader'), 'the marker on the changed list');
    await clickWhenEnabled(evaluate, fieldOf('BEE_UPLOADER_FULL_NODE'), 'the full node switch');
    await waitFor(() => rowText('BEE_UPLOADER_FULL_NODE'), (text) => text.includes('full redeploy'), 'the full redeploy marker');
    await typeInto('ADMIN_API_URL', 'http://admin.offline.example');
    await waitFor(() => rowText('ADMIN_API_URL'), (text) => text.includes('recreates srs and stream-uploader'), 'the two services the admin link recreates');
    assert.match(await cardText(), /3 settings changed/);
    await screenshot('changed-phone.png');
  });

  await t.test('a save sends the changed keys alone, with the revision the page read', async () => {
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === 1, 'the save request');

    assert.deepEqual(writes[0], {
      method: 'PUT',
      path: `/profiles/${RUNNING}/settings`,
      body: {
        expectedInstanceId: RUNNING_INSTANCE,
        expectedRevision: 7,
        entries: [
          { key: 'ADMIN_API_URL', value: 'http://admin.offline.example' },
          { key: 'UPLOADER_START_GATES', value: 'refuse' },
          { key: 'BEE_UPLOADER_FULL_NODE', value: 'true' },
        ],
      },
    });
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the draft cleared by the reload after the save');
    await waitFor(cardText, (text) => text.includes('4 settings are behind the running containers'), 'the banner naming the saved keys');
    assert.match(await cardText(), /Apply redeploys every service of this deployment\. A publisher, if one is live, is disconnected for a few seconds\./);
    assert.match(await rowText('UPLOADER_START_GATES'), /not applied/);
    assert.match(await rowText('UPLOADER_START_GATES'), /Saved, and the running containers still have the old value/);
  });

  await t.test('a reset sends null, and says the key goes back to the default', async () => {
    await clickWhenEnabled(evaluate, buttonIn(rowOf('MAX_QUEUE_SIZE'), 'Reset to default'), 'the reset of the queue size');
    await waitFor(() => rowText('MAX_QUEUE_SIZE'), (text) => text.includes('Goes back to the default when you save.'), 'the pending reset');
    assert.equal(await evaluate(`${fieldOf('MAX_QUEUE_SIZE')}.value`), '100');
    assert.equal(await evaluate(`${fieldOf('MAX_QUEUE_SIZE')}.disabled`), true);

    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === 2, 'the reset save');
    assert.deepEqual(writes[1].body, { expectedInstanceId: RUNNING_INSTANCE, expectedRevision: 8, entries: [{ key: 'MAX_QUEUE_SIZE', value: null }] });
    await waitFor(() => evaluate(`${fieldOf('MAX_QUEUE_SIZE')}?.value`), (value) => value === '100', 'the version value after the reload');
    assert.doesNotMatch(await rowText('MAX_QUEUE_SIZE'), /set here/);
  });

  await t.test('a typed secret is sent once and never comes back to the page', async () => {
    const secret = 'offline-fixture-token-not-a-real-one-0123456789abcdef';
    await typeInto('ADMIN_API_TOKEN', secret);
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === 3, 'the secret save');
    assert.deepEqual(writes[2].body.entries, [{ key: 'ADMIN_API_TOKEN', value: secret }]);
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the reload after the secret save');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_TOKEN')}.value`), '');
    assert.equal((await body()).includes(secret), false);
  });

  await t.test("a refused save shows the manager's sentence under the save and keeps the edit", async () => {
    stage.refuseSave = true;
    await typeInto('ADMIN_API_URL', 'http://other.offline.example');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes(STAGED_REFUSAL), 'the refusal under the save');
    assert.equal(await evaluate(`${fieldOf('ADMIN_API_URL')}.value`), 'http://other.offline.example');
    stage.refuseSave = false;
    await clickWhenEnabled(evaluate, buttonIn(card, 'Discard'), 'the Discard button');
    await waitFor(cardText, (text) => text.includes('Nothing changed yet'), 'the discarded draft');
  });

  await t.test('a save made after somebody else saved says so and reads the settings again', async () => {
    const theirs = afterSave(catalogs.get(RUNNING), [{ key: 'CHEQUEBOOK_MIN_BZZ', value: '2' }]);
    catalogs.set(RUNNING, theirs);
    const before = writes.length;

    await typeInto('CHEQUEBOOK_MIN_BZZ', '3');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the refused save');
    await waitFor(cardText, (text) => text.includes('These settings changed elsewhere after this page read them'), 'the race message');
    await waitFor(() => evaluate(`${fieldOf('CHEQUEBOOK_MIN_BZZ')}?.value`), (value) => value === '2', 'the value the other save stored');
    assert.match(await cardText(), /Nothing changed yet/);
  });

  await t.test('an Apply refused while the deployment is busy says why in words', async () => {
    stage.applyBusy = true;
    await clickWhenEnabled(evaluate, buttonIn(card, 'Apply'), 'the Apply button');
    await waitFor(cardText, (text) => text.includes('The deployment is deploying or stopping right now. Apply once it has finished.'), 'the busy refusal');
    stage.applyBusy = false;
  });

  await t.test('Apply says what it recreated, and the banner goes once nothing is behind', async () => {
    const before = writes.length;
    await clickWhenEnabled(evaluate, buttonIn(card, 'Apply'), 'the Apply button');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the apply request');
    assert.deepEqual(writes[before], { method: 'POST', path: `/profiles/${RUNNING}/settings/apply`, body: { expectedInstanceId: RUNNING_INSTANCE } });
    await waitFor(cardText, (text) => text.includes('Applied. Every service of this deployment is being redeployed with the saved settings.'), 'what Apply did');
    await waitFor(cardText, (text) => !text.includes('behind the running containers'), 'the banner gone');
    // The dropped key is unknown on its own, as a key no running container
    // reads is, which says nothing about when the containers were started.
    assert.doesNotMatch(await cardText(), /started before the manager recorded/);
    await screenshot('applied-phone.png');
  });

  await t.test('a saved segment length is behind the engine and the uploader, which Apply recreates', async () => {
    const before = writes.length;
    await typeInto('HLS_FRAGMENT', '1');
    await waitFor(() => rowText('HLS_FRAGMENT'), (text) => text.includes('unsaved') && text.includes('recreates srs and stream-uploader'), 'the marker on the changed segment length');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the engine save');

    assert.deepEqual(writes[before].body.entries, [{ key: 'HLS_FRAGMENT', value: '1' }]);
    await waitFor(
      cardText,
      (text) => text.includes(
        '1 setting is behind the running containers: HLS_FRAGMENT. Apply recreates srs and stream-uploader. A publisher, if one is live, is disconnected for a few seconds.',
      ),
      'the banner naming the segment length, what Apply recreates and the publisher that drops',
    );
    assert.match(await rowText('HLS_FRAGMENT'), /set here/);
    await screenshot('engine-behind-phone.png');

    await clickWhenEnabled(evaluate, buttonIn(card, 'Apply'), 'the Apply button');
    await waitFor(cardText, (text) => text.includes('Applied. Recreating srs and stream-uploader with the saved settings.'), 'what Apply recreated');
  });

  await t.test('the Engine card marks a saved value saved, not applied until Apply, before and after a reload', async () => {
    const marked = /SRT latency\s+4000 milliseconds\s+Deployment override\s+saved, not applied/;
    const before = writes.length;
    await typeInto('SRT_LATENCY', '4000');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Save'), 'the Save button');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the latency save');
    await waitFor(engineCardText, (text) => marked.test(text), 'the saved latency marked on the Engine card');

    await call('Page.reload');
    await shows('the page read again', 'Stack settings');
    await waitFor(engineCardText, (text) => marked.test(text), 'the saved latency marked after a reload');
    await screenshot('engine-card-saved-not-applied-phone.png', engineCard);

    await clickWhenEnabled(evaluate, buttonIn(card, 'Apply'), 'the Apply button');
    await waitFor(engineCardText, (text) => !text.includes('saved, not applied'), 'the mark gone once applied');
    assert.match(await engineCardText(), /SRT latency\s+4000 milliseconds\s+Deployment override/);
  });

  await t.test('the card takes the whole width of its column on a wide screen', async () => {
    await call('Emulation.setDeviceMetricsOverride', { width: WIDE, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evaluate('innerWidth'), (width) => width === WIDE, 'the wide viewport');
    const widths = await evaluate(`(() => {
      const engine = ${engineCard};
      const settings = ${card};
      return { engine: engine?.getBoundingClientRect().width ?? 0, settings: settings?.getBoundingClientRect().width ?? -1 };
    })()`);
    assert.ok(widths.engine > 0);
    assert.equal(Math.round(widths.settings), Math.round(widths.engine));
    await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });
  });

  await t.test("the Engine card opens no drawer: its Settings button brings this card into view with the engine settings open and the first focused", async () => {
    await call('Page.reload');
    await shows('the page read again, every section folded', 'Stack settings');
    await evaluate('scrollTo(0, 0)');

    await clickWhenEnabled(evaluate, buttonIn(engineCard, 'Settings'), "the Engine card's Settings button");

    await waitFor(() => evaluate('document.activeElement?.id'), (id) => id === 'deployment-setting-HLS_FRAGMENT', 'the segment length focused');
    assert.equal(await evaluate(paintedInView(rowOf('HLS_FRAGMENT'))), true, 'the segment length on screen as it is focused');
    assert.equal(await evaluate(ENGINE_DRAWER_OPEN), false, 'no engine settings drawer opened');
    const engineFold = `[...document.querySelectorAll('#stack-settings h4 button')].find(button => button.textContent.startsWith('Engine settings'))`;
    assert.equal(await evaluate(`${engineFold}?.getAttribute('aria-expanded')`), 'true');
    const shown = await evaluate(`[...document.querySelectorAll('#stack-settings li[data-setting]')].map(row => row.dataset.setting)`);
    assert.deepEqual(shown, ['HLS_FRAGMENT', 'HLS_SEGMENT_MAX', 'HLS_WINDOW', 'SRT_LATENCY'], 'the engine settings and nothing else are open');
    await waitFor(() => evaluate(stillWithin(card)), Boolean, 'the settings card still');
    assert.equal(await evaluate(paintedInView(rowOf('HLS_FRAGMENT'))), true, 'the segment length still on screen once the card is still');
    await capture('engine-settings-from-engine-card-phone.png');
  });

  await t.test('stored engine settings the next deploy would refuse are named above Save, which other keys still pass, and refuse Apply', async () => {
    const stored = `The engine settings saved for this deployment cannot be deployed, so Apply is refused and any other deploy fails until they change. ${CEILING_UNDER_STORED_SEGMENT}`;
    const said = (text) => text.split(CEILING_UNDER_STORED_SEGMENT).length - 1;
    await openDeployment(REFUSED_ENGINE);
    await waitFor(cardText, (text) => text.includes(stored), 'the stored engine settings named above Save');

    await openEverySection();
    await typeInto('MAX_QUEUE_SIZE', '300');
    await waitFor(saveDisabled, (off) => off === false, 'Save on for a stack key alone');
    assert.equal(said(await cardText()), 1, 'the sentence is said once');
    await waitFor(() => evaluate(stillWithin(card)), Boolean, 'the settings card still');
    await screenshot('engine-stored-refused-phone.png', buttonIn(card, 'Save'), 'end');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Discard'), 'the Discard button');

    const before = writes.length;
    await clickWhenEnabled(evaluate, buttonIn(card, 'Apply'), 'the Apply button');
    await waitFor(() => writes.length, (count) => count === before + 1, 'the apply request');
    await waitFor(cardText, (text) => said(text) === 2, "Apply refused with the manager's sentence");

    await typeInto('HLS_FRAGMENT', '2');
    await waitFor(cardText, (text) => !text.includes(stored), 'the stored sentence gone once the draft fixes the pair');
    await waitFor(saveDisabled, (off) => off === false, 'Save on for the fix');
    await clickWhenEnabled(evaluate, buttonIn(card, 'Discard'), 'the Discard button');
  });

  await t.test('a stopped deployment is told Start will use the changes, with no Apply', async () => {
    await openDeployment(STOPPED);
    await waitFor(cardText, (text) => text.includes('Start will use 1 changed setting: LOG_LEVEL.'), 'the stopped banner');
    assert.equal(await evaluate(`Boolean(${buttonIn(card, 'Apply')})`), false);
  });

  await t.test('a deployment started before any record says why no banner can show', async () => {
    await openDeployment(UNRECORDED);
    await waitFor(cardText, (text) => text.includes('none of these settings can be compared with what they run'), 'the unrecorded note');
    assert.equal(await evaluate(`Boolean(${buttonIn(card, 'Apply')})`), false);
  });

  await t.test('a version with no build yet says why and offers no field', async () => {
    await openDeployment(NOT_READY);
    await waitFor(cardText, (text) => text.includes('candidate has no settings yet.'), 'the not ready reason');
    assert.equal(await evaluate(`${card}.querySelectorAll('input, select, textarea').length`), 0);
    assert.equal(await evaluate(`Boolean(${buttonIn(card, 'Save')})`), false);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  t.diagnostic(`screenshots in ${evidence}`);
});
