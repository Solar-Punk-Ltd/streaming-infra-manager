/**
 * The web2 admin link, set up from the pages, in a real Chrome at a phone's
 * width.
 *
 * Levi ruled on 2026-09-25 that linking a deployment's stream uploader to the
 * web2 admin works out of the box. This drives it through the three places it
 * is set. The Manager settings page's card: an address and a token set once
 * for every new uploader deployment, a token that is never shown and only said
 * to be stored, a value the manager would refuse named under its field, Test
 * connection, an address on another origin that asks for the token again, and
 * clearing the stored token. The new-deployment wizard's Web2 admin group: on
 * from the manager's link, a move to a typed token when the address leaves the
 * stored token's origin, the two keys of Advanced settings pointed at it, a
 * deployment created linked with the manager's token copied in, one created
 * with a token typed there, and one created with the link off, which stores an
 * empty address. And a deployment's Stack settings card: a save that moves the
 * address and leaves the token refused, and Test connection right after the
 * two keys, with every outcome's sentence for what the next deploy would give
 * the uploader.
 *
 * A real headless Chrome over a real Vite, proxying to the real dev mock
 * manager, whose Test connection reads its outcome off the address, so every
 * sentence can be seen offline. Runs with the other suites under
 * `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/admin-link-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import { ADMIN_LINK_TEST_OUTCOMES } from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import { adminLinkTestText } from '../src/adminLink/adminLinkText.ts';
import {
  buttonWithText,
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
import { freePort, startMockManager } from './support/mock-manager-process.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A cold Vite cache can hold a page behind a dependency re-optimization, and this is only spent while waiting. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const NARROW = 390;

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** Synthetic, and never expected on any page once typed. */
const TOKEN = 'offline-admin-link-token-0123456789abcdef';
const ADMIN_URL = 'https://admin.offline.example';

const SENTENCES = {
  'token-accepted': 'The web2 admin answered and took the token.',
  'token-refused': 'The web2 admin answered but refused the token.',
  unreachable: 'The web2 admin did not answer from where the manager runs.',
  redirected: 'This address answered with a redirect, so give the address the web2 admin itself answers on.',
  'not-admin': 'Something answered at this address, but not the way a web2 admin does.',
};

test('the web2 admin link for new deployments, set on the Manager settings page at a phone width', { timeout: 300_000 }, async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('admin-link'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await launchChrome(t, origin);
  const { call, evaluate } = browser;
  const evidence = await evidenceDirectory('admin-link-browser-');
  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (finder, description) => {
    await clickWhenEnabled(evaluate, finder, description, COLD_OPTIMIZE_BUDGET_MS);
    await settled();
  };
  const found = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const card = `[...document.querySelectorAll('.MuiPaper-root')].find(paper => paper.querySelector('h3')?.textContent === 'Web2 admin link for new deployments')`;
  const cardText = () => evaluate(`(${card})?.innerText ?? ''`);
  const urlField = found('#manager-admin-link-url');
  const tokenField = found('#manager-admin-link-token');
  const inCard = (text) => `[...((${card})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(text)})`;
  const noSidewaysScroll = () => evaluate('document.documentElement.scrollWidth <= innerWidth');
  /** The page text never holds the token, and no field but a masked one does, which the page text would not show. */
  const tokenNowhereInSight = async () => {
    assert.equal((await body()).includes(TOKEN), false, 'the token is in the page text');
    assert.equal(
      await evaluate(`[...document.querySelectorAll('input, textarea')].some(field => field.type !== 'password' && field.value.includes(${JSON.stringify(TOKEN)}))`),
      false,
      'the token is in a field that is not masked',
    );
  };
  const screenshot = async (name) => {
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(join(evidence, name), Buffer.from(data, 'base64'));
  };
  const testWith = async (url, outcome) => {
    await fillWhenPresent(evaluate, urlField, url, 'the address field');
    await click(inCard('Test connection'), 'the Test connection button');
    await waitFor(cardText, (text) => text.includes(SENTENCES[outcome]), `the ${outcome} sentence`);
  };

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fillWhenPresent(evaluate, found('input[name=username]'), DEV_USERNAME, 'the username field');
  await fillWhenPresent(evaluate, found('input[name=password]'), DEV_PASSWORD, 'the password field');
  await click(buttonWithText('Sign in'), 'the Sign in button');
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot', COLD_OPTIMIZE_BUDGET_MS);

  await t.test('the Manager settings page is in the navigation, and its card starts with no link', async () => {
    await click(found('button[aria-label="open navigation"]'), 'the navigation button');
    await click(`[...document.querySelectorAll('.MuiListItemButton-root')].find(item => item.textContent.trim() === 'Manager settings')`, 'the Manager settings item');
    await waitFor(cardText, (text) => text.includes('No token is stored.'), 'the card with no token stored', COLD_OPTIMIZE_BUDGET_MS);

    assert.equal(await evaluate('location.hash'), '#/manager-settings');
    assert.equal(await readWhenPresent(evaluate, urlField, 'value', 'the address field'), '');
    assert.equal(await evaluate(`${tokenField}.type`), 'password');
    assert.equal(await evaluate(`${tokenField}.getAttribute('autocomplete')`), 'new-password');
    assert.match(await cardText(), /Type the address to test it\./);
    assert.equal(await evaluate(`(${inCard('Test connection')}).disabled`), true);
    assert.match(await cardText(), /The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here\./);
    assert.equal(await noSidewaysScroll(), true);
  });

  await t.test('names an address or a token the manager would refuse under its field, and keeps Save off', async () => {
    await fillWhenPresent(evaluate, urlField, 'https://operator:offline-password@admin.offline.example', 'the address field');
    await waitFor(cardText, (text) => text.includes('ADMIN_API_URL cannot carry a user name or a password.'), 'the address refusal');
    await fillWhenPresent(evaluate, urlField, ADMIN_URL, 'the address field');
    await fillWhenPresent(evaluate, tokenField, 'short', 'the token field');
    await waitFor(cardText, (text) => text.includes('ADMIN_API_TOKEN must be at least 32 characters.'), 'the token refusal');

    assert.equal(await evaluate(`(${inCard('Save')}).disabled`), true);
    assert.equal((await body()).includes('offline-password'), false);
    assert.equal(await noSidewaysScroll(), true);
  });

  await t.test('tests the typed address and token before they are saved', async () => {
    await fillWhenPresent(evaluate, tokenField, TOKEN, 'the token field');
    await testWith(ADMIN_URL, 'token-accepted');
    await tokenNowhereInSight();
  });

  await t.test('saves the link, and afterwards says a token is stored without ever showing it', async () => {
    await click(inCard('Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes('A token is stored. It is never shown.'), 'the stored token');

    assert.equal(await readWhenPresent(evaluate, urlField, 'value', 'the address field'), ADMIN_URL);
    assert.equal(await evaluate(`${tokenField}.value`), '');
    await tokenNowhereInSight();
    await evaluate(`(${card}).scrollIntoView({ block: 'start' })`);
    await screenshot('manager-link-saved-phone.png');
  });

  await t.test('asks for the token again for an address on another origin, and neither saves nor tests the stored one there', async () => {
    await fillWhenPresent(evaluate, urlField, 'https://moved.admin2.offline.example', 'the address field');
    await waitFor(
      cardText,
      (text) => text.includes('The address moves to another one than the stored token was saved with, and the manager sends its stored token only to the address it was saved with. Type the token again for the new address, or clear it.'),
      'the sentence asking for the token again',
    );

    assert.equal(await evaluate(`(${inCard('Save')}).disabled`), true);
    assert.equal(await evaluate(`(${inCard('Test connection')}).disabled`), true);
    assert.equal(await evaluate(`${tokenField}.getAttribute('aria-invalid')`), 'true');
    assert.equal(await noSidewaysScroll(), true);
    await evaluate(`(${card}).scrollIntoView({ block: 'start' })`);
    await screenshot('manager-link-moved-phone.png');
  });

  await t.test("tests other addresses with a typed token, and says each outcome's sentence", async () => {
    await fillWhenPresent(evaluate, tokenField, TOKEN, 'the token field');
    for (const outcome of ['token-refused', 'unreachable', 'redirected', 'not-admin']) {
      await testWith(`https://${outcome}.admin.offline.example`, outcome);
    }
    assert.equal(await noSidewaysScroll(), true);
    await screenshot('manager-link-tested-phone.png');
    await fillWhenPresent(evaluate, urlField, ADMIN_URL, 'the address field');
    await fillWhenPresent(evaluate, tokenField, '', 'the token field');
    await tokenNowhereInSight();
  });

  await t.test('clears the stored token', async () => {
    await click(inCard('Clear the stored token'), 'the Clear button');
    await waitFor(cardText, (text) => text.includes('The stored token is taken out when you save.'), 'the pending clear');
    await click(inCard('Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes('No token is stored.'), 'the cleared token');

    assert.match(await cardText(), /Type a token to test it\./);
    assert.equal(await noSidewaysScroll(), true);

    // What the wizard below starts from: an address and a stored token.
    await fillWhenPresent(evaluate, tokenField, TOKEN, 'the token field');
    await click(inCard('Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes('A token is stored. It is never shown.'), 'the token stored again');
  });

  const dialog = `document.querySelector('.MuiDialog-paper')`;
  const group = `[...(${dialog}?.querySelectorAll('section') ?? [])].find(section => section.querySelector('h4')?.textContent === 'Web2 admin')`;
  const groupText = () => evaluate(`(${group})?.innerText ?? ''`);
  const linkSwitch = `(${group})?.querySelector('input[type=checkbox]')`;
  const dialogFits = () => evaluate(`(() => {
    const paper = ${dialog};
    const content = paper?.querySelector('.MuiDialogContent-root');
    return Boolean(paper) && paper.scrollWidth <= paper.clientWidth && content.scrollWidth <= content.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`);
  const cardRowText = (key) => readWhenPresent(evaluate, `document.querySelector('li[data-setting="${key}"]')`, 'innerText', `the ${key} row`);
  const searchCard = (text) => fillWhenPresent(evaluate, `document.getElementById('stack-settings')?.querySelector('input[aria-label="Search settings"]')`, text, 'the card search');

  /** Opens the wizard on Stream to Swarm with this name and lands on its settings step. */
  const startStream = async (name) => {
    await evaluate(`location.hash = '#/deployments'`);
    await click(buttonWithText('New deployment'), 'the New deployment button');
    await click(`[...document.querySelectorAll('[role=radio]')].find(node => node.textContent.trim().startsWith('Stream to Swarm'))`, 'the Stream to Swarm goal');
    await click(buttonWithText('Continue'), 'the Continue button');
    await fillWhenPresent(evaluate, found('input[placeholder="main-stage"]'), name, 'the name field', COLD_OPTIMIZE_BUDGET_MS);
    await click(buttonWithText('Continue'), 'the Continue button');
    await waitFor(groupText, (text) => text.includes('Link this deployment to the web2 admin'), 'the Web2 admin group', COLD_OPTIMIZE_BUDGET_MS);
  };

  await t.test("the wizard's Web2 admin group starts on, from the manager's own link", async () => {
    await startStream('linked-stream');

    assert.equal(await evaluate(`${linkSwitch}.checked`), true);
    assert.equal(await readWhenPresent(evaluate, `(${group})?.querySelector('input[aria-label="Web2 admin address"]')`, 'value', 'the group address'), ADMIN_URL);
    assert.equal(await evaluate(`(${group}).querySelector('input[type=radio][aria-label="The manager\\'s stored token"]').checked`), true);
    assert.match(await groupText(), /The test runs from where the manager runs/);

    await click(`[...(${group}).querySelectorAll('button')].find(button => button.textContent.trim() === 'Test connection')`, 'the group Test connection button');
    await waitFor(groupText, (text) => text.includes("Linked: the web2 admin took the token and signs its catalog with this deployment's stream address."), 'the linked sentence');
    assert.equal(await dialogFits(), true, 'the dialog scrolls sideways');
    await evaluate(`(${group}).scrollIntoView({ block: 'start' })`);
    await screenshot('wizard-group-on-phone.png');
  });

  await t.test("asks for a typed token once the address leaves the origin the manager's token was saved for", async () => {
    const address = `(${group})?.querySelector('input[aria-label="Web2 admin address"]')`;
    const typedChoice = `(${group}).querySelector('input[type=radio][aria-label="A token typed here"]')`;
    await fillWhenPresent(evaluate, address, 'https://moved.admin2.offline.example', 'the group address');
    await waitFor(
      groupText,
      (text) => text.includes("The manager's stored token was saved for another address, and the manager sends it only there. Type the token for this address."),
      'the sentence on the stored token',
    );
    assert.match(await body(), /Web2 admin: the manager's stored token was saved for another address, so type the token for this one/);
    assert.equal(await evaluate(`[...(${group}).querySelectorAll('button')].find(button => button.textContent.trim() === 'Test connection').disabled`), true);
    assert.equal(await dialogFits(), true, 'the dialog scrolls sideways');

    await click(`[...(${group}).querySelectorAll('button')].find(button => button.textContent.trim() === 'Type a token for this address')`, 'the button that moves to a typed token');
    await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label')`), (label) => label === 'Web2 admin token', 'focus on the token field');
    assert.equal(await evaluate(`${typedChoice}.checked`), true);

    await fillWhenPresent(evaluate, address, ADMIN_URL, 'the group address');
    await click(`(${group}).querySelector('input[type=radio][aria-label="The manager\\'s stored token"]')`, 'the stored token choice');
    await waitFor(() => evaluate(`(${group}).querySelector('input[type=radio][aria-label="The manager\\'s stored token"]').checked`), Boolean, 'the stored token chosen again');
  });

  await t.test('points the two keys of Advanced settings at the group rather than editing them twice', async () => {
    const foldButton = `[...document.querySelectorAll('button[aria-expanded]')].find(button => button.textContent.includes('Advanced settings'))`;
    await click(foldButton, 'the Advanced settings fold');
    await fillWhenPresent(evaluate, `${dialog}?.querySelector('input[aria-label="Search settings"]')`, 'ADMIN_API', 'the list search');
    const rowText = await cardRowText('ADMIN_API_TOKEN');

    assert.match(rowText, /Decided by the Web2 admin group of this step\. It cannot be set here\./);
    assert.match(await cardRowText('ADMIN_API_URL'), new RegExp(`${ADMIN_URL.replace(/\./g, '\\.')}[\\s\\S]*Decided by the Web2 admin group of this step`));
    assert.equal(await evaluate(`Boolean(document.getElementById('deployment-setting-ADMIN_API_TOKEN'))`), false, 'no field for the token');
    await click(foldButton, 'the Advanced settings fold');
  });

  await t.test("creates the deployment linked, with the manager's token copied in and never shown", async () => {
    await click(buttonWithText('Continue'), 'the Continue button');
    await waitFor(body, (text) => text.includes('Check it, then deploy.'), 'the review');
    assert.match(await body(), new RegExp(`Web2 admin\\s+Linked to ${ADMIN_URL.replace(/\./g, '\\.')}, with the manager's stored token\\.`));

    await click(buttonWithText('Deploy'), 'the Deploy button');
    await waitFor(body, (text) => text.includes('linked-stream') && text.includes('Stack settings'), 'the linked-stream page with its settings card');
    await searchCard('ADMIN_API');
    await waitFor(() => cardRowText('ADMIN_API_TOKEN'), (text) => text.includes('A value is stored for this deployment. It is never shown.'), 'the copied token');
    assert.match(await cardRowText('ADMIN_API_URL'), /set here/);
    assert.equal(await evaluate(`document.getElementById('deployment-setting-ADMIN_API_URL').value`), ADMIN_URL);
    await tokenNowhereInSight();
  });

  await t.test('creates a deployment with a token typed in the group, masked, tested and stored', async () => {
    await startStream('typed-stream');
    await click(`(${group}).querySelector('input[type=radio][aria-label="A token typed here"]')`, 'the typed token choice');
    const typedField = `(${group})?.querySelector('input[aria-label="Web2 admin token"]')`;
    assert.equal(await readWhenPresent(evaluate, typedField, 'type', 'the typed token field'), 'password');
    assert.equal(await evaluate(`${typedField}.getAttribute('autocomplete')`), 'new-password');
    await fillWhenPresent(evaluate, typedField, TOKEN, 'the typed token field');
    await click(`[...(${group}).querySelectorAll('button')].find(button => button.textContent.trim() === 'Test connection')`, 'the group Test connection button');
    await waitFor(groupText, (text) => text.includes(adminLinkTestText('linked')), 'the linked sentence for the typed token');
    await tokenNowhereInSight();

    await click(buttonWithText('Continue'), 'the Continue button');
    await waitFor(body, (text) => text.includes('Check it, then deploy.'), 'the review');
    assert.match(await body(), new RegExp(`Web2 admin\\s+Linked to ${ADMIN_URL.replace(/\./g, '\\.')}, with a token typed here\\.`));
    await tokenNowhereInSight();
    await click(buttonWithText('Deploy'), 'the Deploy button');
    await waitFor(body, (text) => text.includes('typed-stream') && text.includes('Stack settings'), 'the typed-stream page with its settings card');
    await searchCard('ADMIN_API');
    await waitFor(() => cardRowText('ADMIN_API_TOKEN'), (text) => text.includes('A value is stored for this deployment. It is never shown.'), 'the typed token stored');
    await tokenNowhereInSight();
  });

  await t.test('creates a deployment with the link switched off, which stores an empty address', async () => {
    await startStream('standalone-stream');
    await click(linkSwitch, 'the link switch');
    await waitFor(groupText, (text) => text.includes('runs standalone'), 'the switched-off note');
    assert.equal(await dialogFits(), true, 'the dialog scrolls sideways');
    await evaluate(`(${group}).scrollIntoView({ block: 'start' })`);
    await screenshot('wizard-group-off-phone.png');

    await click(buttonWithText('Continue'), 'the Continue button');
    await waitFor(body, (text) => text.includes('Check it, then deploy.'), 'the review');
    assert.match(await body(), /Web2 admin\s+Not linked\. The uploader runs standalone\./);
    await click(buttonWithText('Deploy'), 'the Deploy button');
    await waitFor(body, (text) => text.includes('standalone-stream') && text.includes('Stack settings'), 'the standalone-stream page with its settings card');
    await searchCard('ADMIN_API_URL');
    await waitFor(() => cardRowText('ADMIN_API_URL'), (text) => text.includes('set here'), 'the stored empty address');
    assert.equal(await evaluate(`document.getElementById('deployment-setting-ADMIN_API_URL').value`), '');
  });

  const stackCard = `document.getElementById('stack-settings')`;
  const cardTest = `${stackCard}?.querySelector('li [data-admin-link-test]')`;
  const cardTestText = () => evaluate(`(${cardTest})?.innerText ?? ''`);
  const cardTestButton = `[...((${cardTest})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Test connection')`;
  const cardSave = `[...(${stackCard}?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Save')`;
  const stackCardText = () => evaluate(`${stackCard}?.innerText ?? ''`);

  await t.test("a deployment's Stack settings card offers Test connection right after the two keys", async () => {
    await evaluate(`location.hash = '#/deployments/linked-stream'`);
    await waitFor(body, (text) => text.includes('linked-stream') && text.includes('Stack settings'), 'the linked-stream page');
    await searchCard('ADMIN_API');
    await waitFor(cardTestText, (text) => text.includes('Test connection'), 'the test beside the two keys');

    assert.equal(await evaluate(`(${cardTest}).closest('li').previousElementSibling?.dataset.setting`), 'ADMIN_API_TOKEN');
    assert.match(await cardTestText(), /The test runs from where the manager runs/);
    await click(cardTestButton, 'the card Test connection button');
    await waitFor(cardTestText, (text) => text.includes(adminLinkTestText('linked')), 'the linked sentence on the card');
    assert.equal(await noSidewaysScroll(), true);

    // A fold that is still opening clips its rows, so the rows are looked at once it has opened.
    await waitFor(() => evaluate(stillWithin(stackCard)), Boolean, 'the Admin mode fold to finish opening');
    await evaluate(`document.querySelector('li[data-setting="ADMIN_API_URL"]').scrollIntoView({ block: 'center' })`);
    await waitFor(() => evaluate(paintedInView(`document.querySelector('li[data-setting="ADMIN_API_URL"]')`)), Boolean, 'the address row painted above the test');
    await screenshot('card-test-linked-phone.png');
  });

  await t.test('refuses a card save that moves the address to another origin and leaves the stored token, saying why', async () => {
    await fillWhenPresent(evaluate, `document.getElementById('deployment-setting-ADMIN_API_URL')`, 'https://moved.admin2.offline.example', 'the card address field');
    await click(cardSave, 'the card Save button');
    await waitFor(
      stackCardText,
      (text) => text.includes('ADMIN_API_URL moves to another address than the one ADMIN_API_TOKEN was stored with, and the manager sends a stored token only to the address it was stored with. Type ADMIN_API_TOKEN again for the new address, or clear it.'),
      'the refusal on the card',
    );
    assert.equal(await noSidewaysScroll(), true);
  });

  await t.test("says each outcome's sentence for what the next deploy would give the uploader", async () => {
    for (const outcome of ADMIN_LINK_TEST_OUTCOMES.filter((each) => each !== 'linked')) {
      const url = outcome === 'not-linked' ? '' : `https://${outcome}.admin.offline.example`;
      await fillWhenPresent(evaluate, `document.getElementById('deployment-setting-ADMIN_API_URL')`, url, 'the card address field');
      // Each address is another origin, where the stored token does not go, so each is saved with the token typed again.
      await fillWhenPresent(evaluate, `document.getElementById('deployment-setting-ADMIN_API_TOKEN')`, TOKEN, 'the card token field');
      await waitFor(cardTestText, (text) => text.includes('The test uses what is saved, not the changes above that are not saved yet.'), 'the note on an unsaved address');
      await click(cardSave, 'the card Save button');
      await waitFor(stackCardText, (text) => text.includes('Nothing changed yet'), `the saved ${outcome} address`);
      await click(cardTestButton, 'the card Test connection button');
      await waitFor(cardTestText, (text) => text.includes(adminLinkTestText(outcome)), `the ${outcome} sentence on the card`);
    }
    assert.equal(await noSidewaysScroll(), true);
    await waitFor(() => evaluate(stillWithin(stackCard)), Boolean, 'the card to stop moving');
    await evaluate(`document.querySelector('li[data-setting="ADMIN_API_URL"]').scrollIntoView({ block: 'center' })`);
    await screenshot('card-test-not-linked-phone.png');
  });

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  t.diagnostic(`screenshots in ${evidence}`);
});
