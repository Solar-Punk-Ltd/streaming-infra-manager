/**
 * What a browser that will not start is allowed to cost.
 *
 * In a container running as root every Chrome suite reported the same line, sixteen
 * files in a row: "Timed out waiting for Chrome debugging port". Chrome had
 * said why on its own standard error, immediately and in one line, and the
 * launcher spawned it with `stdio: 'ignore'`, so the only thing that reached
 * the run was the absence of a port file fifteen seconds later. Two whole deep
 * runs went on learning nothing from that, which is 53 identical errors and no
 * reason among them.
 *
 * A browser that dies is a browser that has already explained itself. These
 * cases hold the launcher to reporting the explanation, and to noticing the
 * death rather than waiting out a budget for a port that no live process is
 * going to write.
 *
 * A Node-only file: no browser, no Vite. `CHROME_BIN` points at a script that
 * behaves the way a refusing Chrome behaves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { browserArguments, browserEnvironment, browserIdentity, launchChrome } from './chrome.mjs';

/**
 * A stand-in that refuses on standard error and exits, which is what a refusing
 * Chrome does.
 *
 * It is the Node binary rather than a script written for the occasion. Some
 * containers mount their temporary directory `noexec`, so a shell script
 * created there cannot be executed at all and the case fails with EACCES before
 * it reaches the behaviour under test. Node is already executable wherever this
 * suite runs, and it refuses Chrome's flags on standard error and exits, which
 * is the shape the case needs.
 */
const browserThatRefuses = () => process.execPath;

test('says what the browser said when it refuses to start', async (t) => {
  process.env.CHROME_BIN = browserThatRefuses();

  const failure = await launchChrome(t, 'http://127.0.0.1:1').then(() => null, (error) => error);

  assert.ok(failure, 'a browser that exited must not look like a browser that started');
  // Whatever it objected to, it objected in its own words about our own first
  // flag, so finding that flag in the failure proves the stream reached us.
  assert.match(failure.message, /--headless=new/, `the browser's own reason is missing: ${failure.message}`);
});

test('gives up when the browser is gone rather than waiting out the budget', async (t) => {
  process.env.CHROME_BIN = browserThatRefuses();
  const startedAt = Date.now();

  await launchChrome(t, 'http://127.0.0.1:1').then(() => null, () => null);

  // The port wait alone is fifteen seconds. A process that has already exited
  // is never going to write the file it is waiting for.
  assert.ok(Date.now() - startedAt < 10_000, `waited ${Date.now() - startedAt}ms for a process that had exited`);
});

test('reports the exit status, because a refusal and a crash are different faults', async (t) => {
  process.env.CHROME_BIN = browserThatRefuses();

  const failure = await launchChrome(t, 'http://127.0.0.1:1').then(() => null, (error) => error);

  assert.match(failure.message, /(exited \d+|was killed by \w+)/, `the exit status is missing: ${failure.message}`);
});

/**
 * Who runs the browser, and what that costs.
 *
 * Chrome will not run as root unless the sandbox is turned off, which is why
 * every browser suite refused inside a container running as root. The flag
 * is the usual answer and it is the worse one: passing it unconditionally drops
 * the sandbox on a laptop that never needed it. A browser image built for
 * containers ships a `pwuser` account for exactly this case, so where that
 * account exists the browser runs as it and keeps its sandbox in both places.
 *
 * The decision is separated from the spawning so it can be checked here, where
 * the process is neither root nor inside that image.
 */
const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'pwuser:x:1001:1001::/home/pwuser:/bin/bash',
].join('\n');

test('runs as ourselves and keeps the sandbox when we are not root', () => {
  assert.deepEqual(browserIdentity(501, PASSWD), { runAs: null, sandbox: true });
});

test('drops root to pwuser where it exists, and the sandbox either way', () => {
  assert.deepEqual(browserIdentity(0, PASSWD), { runAs: { uid: 1001, gid: 1001 }, sandbox: false });
});

test('still drops the sandbox where root has nobody else to be', () => {
  assert.deepEqual(browserIdentity(0, 'root:x:0:0:root:/root:/bin/bash'), { runAs: null, sandbox: false });
});

test('does not mistake another account for pwuser', () => {
  assert.deepEqual(browserIdentity(0, 'pwuser2:x:1002:1002::/home/pwuser2:/bin/sh'), { runAs: null, sandbox: false });
});

test('ignores a line it cannot read rather than inventing an account', () => {
  assert.deepEqual(browserIdentity(0, 'pwuser:x:notanumber:1001::/home/pwuser:/bin/sh'), { runAs: null, sandbox: false });
});

/**
 * Where the browser is allowed to write when it is somebody else.
 *
 * Running as `pwuser` fixed the root refusal and revealed the next one: Chrome
 * was killed by SIGTRAP with `chrome_crashpad_handler: --database is required`,
 * because its crash handler wants a writable home and the process had inherited
 * root's. The profile directory is the one place the new user certainly owns,
 * since the launcher hands it over before spawning.
 */
test('gives a browser running as somebody else a home it can write', () => {
  const identity = { runAs: { uid: 1001, gid: 1001 }, sandbox: true };

  assert.equal(browserEnvironment(identity, '/nowhere/profile', { HOME: '/root', PATH: '/usr/bin' }).HOME, '/nowhere/profile');
  assert.equal(browserEnvironment(identity, '/nowhere/profile', { HOME: '/root', PATH: '/usr/bin' }).PATH, '/usr/bin');
});

test('leaves the environment alone when the browser runs as us', () => {
  const environment = { HOME: '/nowhere/a-home', PATH: '/usr/bin' };

  assert.deepEqual(browserEnvironment({ runAs: null, sandbox: true }, '/nowhere/profile', environment), environment);
});

/**
 * The flags that belong to a browser in a container, and to no other.
 *
 * With the launcher finally able to say what it saw, the seven files that
 * failed in that container turned out not to be slow: every one had read an empty
 * page for the whole fifteen seconds. The first load of each suite worked and
 * the reload after it produced nothing at all, which is what a renderer that
 * cannot allocate shared memory looks like from the outside. A container gets
 * 64 MiB of /dev/shm by default and Chrome wants more, so it puts its shared
 * memory in a temporary directory instead when told to.
 *
 * It is tied to the same fact that decides the sandbox, being root, because
 * that is what tells us we are in that container rather than on a laptop where
 * /dev/shm is the machine's own and nothing needs redirecting.
 */
test('a browser in the container is told not to rely on a tiny /dev/shm', () => {
  const args = browserArguments({ runAs: { uid: 1001, gid: 1001 }, sandbox: false }, '/nowhere/profile');

  assert.ok(args.includes('--no-sandbox'), args.join(' '));
  assert.ok(args.includes('--disable-dev-shm-usage'), args.join(' '));
});

test('a browser on a laptop is told neither, and keeps both', () => {
  const args = browserArguments({ runAs: null, sandbox: true }, '/nowhere/profile');

  assert.equal(args.includes('--no-sandbox'), false, args.join(' '));
  assert.equal(args.includes('--disable-dev-shm-usage'), false, args.join(' '));
});

test('every browser is given the profile it was told to use', () => {
  assert.ok(browserArguments({ runAs: null, sandbox: true }, '/nowhere/p').includes('--user-data-dir=/nowhere/p'));
  assert.ok(browserArguments({ runAs: null, sandbox: false }, '/nowhere/p').includes('--user-data-dir=/nowhere/p'));
});
