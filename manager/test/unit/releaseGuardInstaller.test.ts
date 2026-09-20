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
    await chmod(join(packet, 'deploy/install-release-guard.sh'), 0o700);
    await chmod(join(packet, 'deploy/release-mode.sh'), 0o700);
    await chmod(join(packet, 'deploy/release-guard/streaming-release-guard'), 0o700);
    for (const output of OUTPUTS) await writeFile(join(packet, 'manager/dist/releaseGuard', output), 'export {};\n');
    await writeFile(join(packet, 'manager/dist/releaseGuard/ReleaseGuardCli.js'), `
import { mkdirSync, writeFileSync } from 'node:fs';
const [command, flag, stateRoot] = process.argv.slice(2);
if (flag !== '--state-root' || !stateRoot) process.exit(2);
if (command === 'install') {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(stateRoot + '/installed.json', '{}');
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
      '--uploader-services', 'bee-uploader,srs,stream-uploader',
      '--viewer-profile', 'viewer',
      '--viewer-port-slot', '2',
      '--viewer-services', 'bee-gateway,client',
    ], { env: { ...process.env, HOME: home } });

    assert.match(result.stdout, /installed in legacy mode/);
    const codeRoot = join(home, '.local/lib/streaming-release-guard/current');
    for (const output of OUTPUTS) assert.equal((await lstat(join(codeRoot, output))).isFile(), true);
    const launcher = await readFile(join(home, '.local/bin/streaming-release-guard'), 'utf8');
    assert.match(launcher, /manager-stdin/);
    assert.match(launcher, /ReleaseGuardManagerStdin\.js/);
    await assert.rejects(
      execFileAsync(join(packet, 'deploy/install-release-guard.sh'), [], { env: { ...process.env, HOME: home } }),
      /already exists or is partial/,
    );
  });
});
