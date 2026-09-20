import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO = resolve(import.meta.dirname, '../../..');
const OUTPUTS = [
  'FixedReleaseAdapter.js',
  'ReleaseGuardCli.js',
  'ReleaseGuardManagerStdin.js',
  'ReleaseGuardStore.js',
  'ReleaseGuardTypes.js',
  'ReleaseReceiptSubmitter.js',
  'ReleaseTransition.js',
];

describe('release guard source installer', () => {
  it('installs immutable external code and refuses replacement or partial reuse', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'release-guard-installer-'));
    const packet = join(root, 'packet');
    const home = join(root, 'home');
    t.after(async () => {
      await chmod(join(home, '.local/lib/streaming-release-guard/current'), 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(packet, 'deploy/release-guard'), { recursive: true });
    await mkdir(join(packet, 'manager/dist/releaseGuard'), { recursive: true });
    await copyFile(join(REPO, 'deploy/install-release-guard.sh'), join(packet, 'deploy/install-release-guard.sh'));
    await copyFile(join(REPO, 'deploy/release-mode.sh'), join(packet, 'deploy/release-mode.sh'));
    await copyFile(
      join(REPO, 'deploy/release-guard/streaming-release-guard'),
      join(packet, 'deploy/release-guard/streaming-release-guard'),
    );
    await copyFile(
      join(REPO, 'deploy/release-guard/streaming-release-guard-container'),
      join(packet, 'deploy/release-guard/streaming-release-guard-container'),
    );
    await chmod(join(packet, 'deploy/install-release-guard.sh'), 0o700);
    await chmod(join(packet, 'deploy/release-mode.sh'), 0o700);
    await chmod(join(packet, 'deploy/release-guard/streaming-release-guard'), 0o700);
    await chmod(join(packet, 'deploy/release-guard/streaming-release-guard-container'), 0o700);
    for (const output of OUTPUTS) await writeFile(join(packet, 'manager/dist/releaseGuard', output), 'export {};\n');
    await writeFile(join(packet, 'manager/dist/releaseGuard/ReleaseGuardCli.js'), `
import { mkdirSync, writeFileSync } from 'node:fs';
const [command, flag, stateRoot] = process.argv.slice(2);
if (flag !== '--state-root' || !stateRoot) process.exit(2);
if (command === 'install') {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(stateRoot + '/installed.json', '{}');
  writeFileSync(stateRoot + '/install-arguments.json', JSON.stringify(process.argv.slice(2)));
} else if (command === 'status') {
  process.stdout.write('legacy\\n');
} else process.exit(2);
`);

    const result = await execFileAsync(join(packet, 'deploy/install-release-guard.sh'), [
      '--manager-mode', 'isolated',
      '--manager-project-name', 'manager-test',
      '--manager-postgres-volume-name', 'manager-test-pg',
      '--manager-postgres-port', '15432',
      '--manager-web-port', '18080',
      '--uploader-profile', 'managed',
      '--uploader-port-slot', '1',
      '--uploader-services', 'bee-gateway,bee-uploader,bee-uploader-1080p,bee-uploader-480p,bee-uploader-720p,client,srs,stream-uploader',
      '--viewer-profile', 'viewer',
      '--viewer-port-slot', '2',
      '--viewer-services', 'bee-gateway,client',
    ], { env: { ...process.env, HOME: home } });

    assert.match(result.stdout, /installed in legacy mode/);
    const installedArguments = JSON.parse(
      await readFile(join(home, '.local/state/streaming-release-guard/install-arguments.json'), 'utf8'),
    );
    assert.deepEqual(installedArguments.slice(
      installedArguments.indexOf('--uploader-services'),
      installedArguments.indexOf('--uploader-services') + 2,
    ), [
      '--uploader-services',
      'bee-gateway,bee-uploader,bee-uploader-1080p,bee-uploader-480p,bee-uploader-720p,client,srs,stream-uploader',
    ]);
    const codeRoot = join(home, '.local/lib/streaming-release-guard/current');
    for (const output of OUTPUTS) assert.equal((await lstat(join(codeRoot, output))).isFile(), true);
    const containerLauncher = await readFile(join(codeRoot, 'streaming-release-guard'), 'utf8');
    assert.match(containerLauncher, /\/opt\/streaming-release-guard\/ReleaseGuardCli\.js/);
    assert.equal((await lstat(join(codeRoot, 'streaming-release-guard'))).mode & 0o777, 0o555);
    const launcher = await readFile(join(home, '.local/bin/streaming-release-guard'), 'utf8');
    assert.match(launcher, /manager-stdin/);
    assert.match(launcher, /ReleaseGuardManagerStdin\.js/);
    await assert.rejects(
      execFileAsync(join(packet, 'deploy/install-release-guard.sh'), [], { env: { ...process.env, HOME: home } }),
      /already exists or is partial/,
    );
  });

  it('derives one isolated guard installation from the validated fixture identity', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'release-guard-fixture-installer-'));
    const packet = join(root, 'packet');
    const home = join(root, 'home');
    const fixtureBase = join(root, 'fixture-installations');
    const fixtureId = 'srs-continuation-20260920-a1b2c3d4';
    const guardRoot = join(fixtureBase, fixtureId, 'guard');
    t.after(async () => {
      await chmod(join(guardRoot, 'lib/streaming-release-guard/current'), 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(packet, 'deploy/release-guard'), { recursive: true });
    await mkdir(join(packet, 'manager/dist/releaseGuard'), { recursive: true });
    for (const relative of [
      'deploy/install-release-guard.sh',
      'deploy/release-mode.sh',
      'deploy/release-guard/streaming-release-guard',
    ]) {
      const source = await readFile(join(REPO, relative), 'utf8');
      await writeFile(
        join(packet, relative),
        source.replaceAll('/home/solarpunk/srs-continuation-tests-20260920', fixtureBase),
      );
      await chmod(join(packet, relative), 0o700);
    }
    await copyFile(
      join(REPO, 'deploy/release-guard/streaming-release-guard-container'),
      join(packet, 'deploy/release-guard/streaming-release-guard-container'),
    );
    await chmod(join(packet, 'deploy/release-guard/streaming-release-guard-container'), 0o700);
    for (const output of OUTPUTS) await writeFile(join(packet, 'manager/dist/releaseGuard', output), 'export {};\n');
    await writeFile(join(packet, 'manager/dist/releaseGuard/ReleaseGuardCli.js'), `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const [command, flag, stateRoot] = process.argv.slice(2);
if (flag !== '--state-root' || !stateRoot) process.exit(2);
if (command === 'install') {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(stateRoot + '/installed.json', '{}');
} else if (command === 'status') {
  process.stdout.write('legacy\\n');
} else if (command === 'begin-legacy') {
  process.stdout.write(existsSync(stateRoot + '/activated') ? 'managed\\n' : 'legacy:22222222-2222-4222-8222-222222222222\\n');
} else process.exit(2);
`);

    const args = [
      '--manager-mode', 'isolated',
      '--manager-project-name', 'fixture-manager',
      '--manager-postgres-volume-name', 'fixture-manager-pg',
      '--manager-postgres-port', '25432',
      '--manager-web-port', '28080',
      '--fixture-network-name', `${fixtureId}-network`,
      '--fixture-id', fixtureId,
    ];
    await execFileAsync(join(packet, 'deploy/install-release-guard.sh'), args, {
      env: { ...process.env, HOME: home },
    });

    assert.equal((await lstat(join(guardRoot, 'bin/streaming-release-guard'))).isFile(), true);
    assert.equal((await lstat(join(guardRoot, 'state/streaming-release-guard'))).isDirectory(), true);
    await assert.rejects(lstat(join(home, '.local/bin/streaming-release-guard')), { code: 'ENOENT' });
    const launcher = await readFile(join(guardRoot, 'bin/streaming-release-guard'), 'utf8');
    assert.doesNotMatch(launcher, /HOME/);

    await writeFile(join(guardRoot, 'state/streaming-release-guard/activated'), 'yes\n');
    const mode = await execFileAsync(join(packet, 'deploy/release-mode.sh'), [
      'begin', '--fixture-id', fixtureId,
    ], { env: { ...process.env, HOME: home } });
    assert.equal(mode.stdout.trim(), 'managed');
  });
});
