import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  ReleaseGuardStore,
  installReleaseGuard,
} from '../../src/releaseGuard/ReleaseGuardStore.js';
import {
  digestTree,
  runReleaseTransition,
  type ReleaseAdapter,
} from '../../src/releaseGuard/ReleaseTransition.js';
import { submitPendingReceipt } from '../../src/releaseGuard/ReleaseReceiptSubmitter.js';
import type {
  ReleaseArtifact,
  ReleaseSlot,
} from '../../src/releaseGuard/ReleaseGuardTypes.js';
import { FixedReleaseAdapter } from '../../src/releaseGuard/FixedReleaseAdapter.js';
import { runReleaseGuardCli } from '../../src/releaseGuard/ReleaseGuardCli.js';

const execFileAsync = promisify(execFile);
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const UPLOADER_ID = 'srs-uploader-a';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const WEB_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const MANAGER_TARGET = {
  mode: 'production' as const,
  projectName: 'manager-test',
  postgresVolumeName: 'manager-test-pg',
  postgresPort: 15_432,
  webPort: 18_080,
};
const ISOLATED_MANAGER_TARGET = {
  mode: 'isolated' as const,
  projectName: 'manager-isolated',
  postgresVolumeName: 'manager-isolated-pg',
  postgresPort: 25_432,
  webPort: 28_080,
};
const UPLOADER_TARGET = {
  profile: 'managed',
  portSlot: 1,
  target: 'local' as const,
  services: [
    'bee-gateway',
    'bee-uploader',
    'bee-uploader-1080p',
    'bee-uploader-480p',
    'bee-uploader-720p',
    'client',
    'srs',
    'stream-uploader',
  ],
};
const VIEWER_TARGET = {
  profile: 'viewer',
  portSlot: 2,
  target: 'local' as const,
  services: ['bee-gateway', 'client'],
};
const FIXTURE_NETWORK = {
  name: 'srs-continuation-20260920-a1b2c3d4-network',
  fixtureId: 'srs-continuation-20260920-a1b2c3d4',
};
const FIXTURE_NETWORK_ID = 'c'.repeat(64);
const FIXTURE_VOLUME_NAMES = [
  `${UPLOADER_TARGET.profile}_srs-media`,
  `${UPLOADER_TARGET.profile}_uploader-state`,
];
const TRANSITION_DIGEST = 'd'.repeat(64);
const EMPTY_PREFLIGHT_TRANSITION_DIGEST = createHash('sha256').update('null\n').digest('hex');
const MANAGER_BASE = '87673c99ecbf3685fc04773d95877d128b909113';
const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURE_READY_TIMEOUT_MS = 5_000;
const FIXTURE_DIAGNOSTIC_BYTES = 8 * 1024;

function inheritedModuleLoaderArgs(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if (argument === '--import' || argument === '--loader') {
      const value = process.execArgv[index + 1];
      if (value !== undefined) args.push(argument, value);
      index += 1;
    } else if (
      argument.startsWith('--import=') ||
      argument.startsWith('--loader=') ||
      argument === '--conditions' ||
      argument.startsWith('--conditions=')
    ) {
      args.push(argument);
      if (argument === '--conditions' && process.execArgv[index + 1] !== undefined) {
        args.push(process.execArgv[index + 1]);
        index += 1;
      }
    }
  }
  return args;
}

async function waitForLockFixture(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => finish(new Error(`lock fixture readiness timed out: ${stderr}`)),
      FIXTURE_READY_TIMEOUT_MS,
    );
    const onStdout = (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-FIXTURE_DIAGNOSTIC_BYTES);
      if (stdout.includes('locked\n')) finish();
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-FIXTURE_DIAGNOSTIC_BYTES);
    };
    const onError = () => finish(new Error('lock fixture could not start'));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(
        `lock fixture closed before readiness (exit ${code ?? 'none'}, signal ${signal ?? 'none'}): ${stderr}`,
      ));
    };
    function finish(error?: Error) {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) rejectReady(error);
      else resolveReady();
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function temporaryRoot(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'release-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + FIXTURE_READY_TIMEOUT_MS;
  while (!(await lstat(path).catch(() => null))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}

async function capableCandidate(root: string, role = 'uploader') {
  const manifest = role === 'admin'
    ? join(root, 'web2-admin/backend/release-capabilities.json')
    : join(root, 'deploy', role === 'manager' ? 'release-capabilities.json' : 'capabilities.json');
  await mkdir(join(manifest, '..'), { recursive: true });
  await writeFile(
    manifest,
    `${JSON.stringify({ schemaVersion: 1, capabilities: { srsLifecycle: 1 } })}\n`,
  );
  await writeFile(join(root, `${role}.txt`), 'candidate artifact\n');
}

function adapter(counters: { build: number; stop: number; start: number }): ReleaseAdapter {
  return {
    async preflight() {},
    async build() {
      counters.build += 1;
      return { schemaVersion: 1, images: [{ service: 'stream-uploader', imageId: IMAGE_ID }] };
    },
    async transition() {
      counters.stop += 1;
      counters.start += 1;
    },
    async verify() {
      return { schemaVersion: 1, images: [{ service: 'stream-uploader', imageId: IMAGE_ID }] };
    },
  };
}

async function verifiedReceipt(
  store: ReleaseGuardStore,
  input: { slot: ReleaseSlot; artifact: ReleaseArtifact },
) {
  return store.withTransition(async (lease) => {
    const pending = await lease.prepare({ ...input, transitionDigest: TRANSITION_DIGEST });
    await lease.markVerified(pending.body);
    return pending;
  });
}

describe('external release guard state', () => {
  it('binds validated deployment targets to the guard installation', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID, {
      manager: MANAGER_TARGET,
      uploader: UPLOADER_TARGET,
      viewer: VIEWER_TARGET,
    });
    const store = new ReleaseGuardStore(root);
    assert.deepEqual(await store.deploymentTarget('manager'), MANAGER_TARGET);
    assert.deepEqual(await store.deploymentTarget('uploader'), UPLOADER_TARGET);
    assert.deepEqual(await store.deploymentTarget('viewer'), VIEWER_TARGET);
    await assert.rejects(store.deploymentTarget('admin'), /admin target is not installed/);

    const targetPath = join(root, 'targets.json');
    const targets = JSON.parse(await readFile(targetPath, 'utf8'));
    targets.targets.manager.webPort = 18_081;
    await writeFile(targetPath, `${JSON.stringify(targets)}\n`);
    await assert.rejects(store.read(), /installed guard state is invalid/);

    await assert.rejects(
      installReleaseGuard(join(root, 'invalid'), INSTALLATION_ID, {
        manager: { ...MANAGER_TARGET, projectName: 'manager/test' },
      }),
      /deployment targets are invalid/,
    );
    await assert.rejects(
      installReleaseGuard(join(root, 'invalid-uploader'), INSTALLATION_ID, {
        uploader: { ...UPLOADER_TARGET, services: ['ome', 'stream-uploader'] },
      }),
      /deployment targets are invalid/,
    );
    await assert.rejects(
      installReleaseGuard(join(root, 'invalid-viewer'), INSTALLATION_ID, {
        viewer: { ...VIEWER_TARGET, profile: 'viewer/path' },
      }),
      /deployment targets are invalid/,
    );
    await installReleaseGuard(join(root, 'isolated'), INSTALLATION_ID, { manager: ISOLATED_MANAGER_TARGET });
    const fixtureRoot = join(root, 'fixture-network');
    await installReleaseGuard(fixtureRoot, INSTALLATION_ID, {
      manager: ISOLATED_MANAGER_TARGET,
      fixtureNetwork: FIXTURE_NETWORK,
    });
    assert.deepEqual(await new ReleaseGuardStore(fixtureRoot).fixtureNetwork(), FIXTURE_NETWORK);
    await assert.rejects(
      installReleaseGuard(join(root, 'fixture-without-isolation'), INSTALLATION_ID, {
        fixtureNetwork: FIXTURE_NETWORK,
      }),
      /deployment targets are invalid/,
    );
    await assert.rejects(
      installReleaseGuard(join(root, 'live-port'), INSTALLATION_ID, {
        manager: { ...ISOLATED_MANAGER_TARGET, postgresPort: 5_432 },
      }),
      /deployment targets are invalid/,
    );
    await assert.rejects(
      installReleaseGuard(join(root, 'shared-port'), INSTALLATION_ID, {
        manager: { ...ISOLATED_MANAGER_TARGET, postgresPort: ISOLATED_MANAGER_TARGET.webPort },
      }),
      /deployment targets are invalid/,
    );
  });

  it('distinguishes a pristine legacy installation from durable managed activation', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);
    assert.equal(await store.releaseMode(), 'legacy');

    await verifiedReceipt(store, {
      slot: { role: 'manager', id: 'default' },
      artifact: {
        treeDigest: '1'.repeat(64),
        images: [{ service: 'api', imageId: IMAGE_ID }],
      },
    });

    assert.equal(await store.releaseMode(), 'managed');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'managed-required.json'), 'utf8')),
      { schemaVersion: 1, installationId: INSTALLATION_ID },
    );
  });

  it('refuses partial activation on either side of sentinel publication', async (t) => {
    const stateFirst = join(await temporaryRoot(t), 'state-first');
    await installReleaseGuard(stateFirst, INSTALLATION_ID);
    const stateFirstStore = new ReleaseGuardStore(stateFirst);
    await verifiedReceipt(stateFirstStore, {
      slot: { role: 'manager', id: 'default' },
      artifact: {
        treeDigest: '2'.repeat(64),
        images: [{ service: 'api', imageId: IMAGE_ID }],
      },
    });
    await rm(join(stateFirst, 'managed-required.json'));
    await assert.rejects(stateFirstStore.releaseMode(), /activation sentinel is missing/);

    const sentinelFirst = join(await temporaryRoot(t), 'sentinel-first');
    await installReleaseGuard(sentinelFirst, INSTALLATION_ID);
    await writeFile(
      join(sentinelFirst, 'managed-required.json'),
      `${JSON.stringify({ schemaVersion: 1, installationId: INSTALLATION_ID })}\n`,
    );
    await assert.rejects(new ReleaseGuardStore(sentinelFirst).releaseMode(), /activation state is partial/);

    const linked = join(await temporaryRoot(t), 'linked');
    await installReleaseGuard(linked, INSTALLATION_ID);
    await symlink(join(linked, 'installed.json'), join(linked, 'managed-required.json'));
    await assert.rejects(new ReleaseGuardStore(linked).releaseMode(), /activation sentinel is invalid/);
  });

  it('fails closed when installed state disappears or becomes unreadable', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);

    await rm(join(root, 'state.json'));
    await assert.rejects(store.read(), /installed guard state is missing/);

    await writeFile(join(root, 'state.json'), '{broken');
    await assert.rejects(store.read(), /installed guard state is invalid/);
  });

  it('persists independent monotonic slots and an exact retry body', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);
    const artifact = {
      treeDigest: 'b'.repeat(64),
      images: [{ service: 'stream-uploader', imageId: IMAGE_ID }],
    };

    const first = await verifiedReceipt(store, {
      slot: { role: 'uploader', id: UPLOADER_ID },
      artifact,
    });
    const retry = await store.pendingReceipt({ role: 'uploader', id: UPLOADER_ID });
    assert.equal(retry, first.body);
    assert.equal(first.receipt.generation, 1);

    await store.acknowledge(first.body);
    assert.equal(await store.pendingReceipt({ role: 'uploader', id: UPLOADER_ID }), null);

    const viewer = await verifiedReceipt(store, {
      slot: { role: 'viewer', id: 'default' },
      artifact: {
        treeDigest: 'c'.repeat(64),
        images: [{ service: 'client', imageId: `sha256:${'d'.repeat(64)}` }],
      },
    });
    assert.equal(viewer.receipt.generation, 2);
    assert.equal((await store.read()).installationId, INSTALLATION_ID);

    await assert.rejects(
      store.withTransition((lease) => lease.prepare({
        slot: { role: 'uploader', id: 'srs/uploader' }, artifact, transitionDigest: TRANSITION_DIGEST,
      })),
      /uploader slot id is invalid/,
    );
  });

  it('fails closed on a stale crash lock and requires explicit operator recovery', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    await mkdir(join(root, 'state.lock'));

    await assert.rejects(
      new ReleaseGuardStore(root).withTransition(async () => undefined),
      /crash lock requires operator recovery/,
    );
  });

  it('keeps a real killed transition locked until explicit operator recovery', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const child = spawn(process.execPath, [
      ...inheritedModuleLoaderArgs(),
      join(REPO, 'manager/test/fixtures/releaseGuardHoldLock.ts'),
      root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (!child.killed) child.kill('SIGKILL'); });
    await waitForLockFixture(child);

    const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
    assert.equal(child.kill('SIGKILL'), true);
    await closed;
    assert.equal((await lstat(join(root, 'state.lock'))).isDirectory(), true);
    await assert.rejects(
      new ReleaseGuardStore(root).withTransition(async () => undefined),
      /crash lock requires operator recovery/,
    );
  });

  it('holds a legacy deployment lease across the standalone mutation window', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);

    const lease = await store.beginLegacyLease();
    assert.equal(lease.mode, 'legacy');
    if (lease.mode !== 'legacy') throw new Error('expected a legacy lease');
    assert.match(lease.ownerToken, /^[0-9a-f-]{36}$/);
    await assert.rejects(
      store.withTransition(async () => undefined),
      /crash lock requires operator recovery/,
    );
    await assert.rejects(
      store.finishLegacyLease('22222222-2222-4222-8222-222222222222'),
      /owner token does not match/,
    );
    assert.equal((await lstat(join(root, 'state.lock'))).isDirectory(), true);

    await store.finishLegacyLease(lease.ownerToken);
    await store.withTransition(async () => undefined);
  });

  it('cannot release a successor after a duplicate legacy finish pauses after reading the owner', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);
    const first = await store.beginLegacyLease();
    assert.equal(first.mode, 'legacy');
    if (first.mode !== 'legacy') throw new Error('expected a legacy lease');

    const fixtureRoot = join(root, 'paused-finisher');
    await mkdir(fixtureRoot);
    await copyFile(
      join(REPO, 'manager/src/releaseGuard/ReleaseGuardTypes.ts'),
      join(fixtureRoot, 'ReleaseGuardTypes.ts'),
    );
    const storeSource = await readFile(
      join(REPO, 'manager/src/releaseGuard/ReleaseGuardStore.ts'),
      'utf8',
    );
    const ownerRead = 'owner = JSON.parse(await readBounded(ownerPath));';
    assert.match(storeSource, new RegExp(ownerRead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await writeFile(
      join(fixtureRoot, 'ReleaseGuardStore.ts'),
      storeSource.replace(ownerRead, `${ownerRead}
      await writeFile(process.env.RELEASE_FINISH_READY!, 'ready\\n');
      while (!(await lstat(process.env.RELEASE_FINISH_CONTINUE!).catch(() => null))) await delay(10);`)
        .replace(
          "import { chmod, link, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';",
          "import { chmod, link, lstat, mkdir, open, rename, rm, rmdir, writeFile } from 'node:fs/promises';\nimport { setTimeout as delay } from 'node:timers/promises';",
        ),
    );
    await writeFile(
      join(fixtureRoot, 'finish.ts'),
      "import { ReleaseGuardStore } from './ReleaseGuardStore.js';\nvoid new ReleaseGuardStore(process.argv[2]!).finishLegacyLease(process.argv[3]!);\n",
    );
    const ready = join(fixtureRoot, 'ready');
    const resume = join(fixtureRoot, 'resume');
    const paused = spawn(process.execPath, [
      ...inheritedModuleLoaderArgs(),
      join(fixtureRoot, 'finish.ts'),
      root,
      first.ownerToken,
    ], {
      env: { ...process.env, RELEASE_FINISH_READY: ready, RELEASE_FINISH_CONTINUE: resume },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pausedStderr = '';
    paused.stderr.on('data', (chunk: Buffer) => {
      pausedStderr = `${pausedStderr}${chunk.toString('utf8')}`.slice(-FIXTURE_DIAGNOSTIC_BYTES);
    });
    t.after(() => { if (paused.exitCode === null) paused.kill('SIGKILL'); });
    await Promise.race([
      waitForFile(ready),
      new Promise<never>((_resolve, reject) => paused.once('close', (code, signal) => {
        reject(new Error(`paused finisher closed before readiness (exit ${code ?? 'none'}, signal ${signal ?? 'none'}): ${pausedStderr}`));
      })),
    ]);

    await store.finishLegacyLease(first.ownerToken);
    const successor = await store.beginLegacyLease();
    assert.equal(successor.mode, 'legacy');
    if (successor.mode !== 'legacy') throw new Error('expected a successor legacy lease');
    await writeFile(resume, 'continue\n');
    const pausedExit = await new Promise<number | null>((resolveClose) => paused.once('close', resolveClose));

    assert.notEqual(pausedExit, 0);
    assert.equal((await lstat(join(root, 'state.lock'))).isDirectory(), true);
    await assert.rejects(store.finishLegacyLease(first.ownerToken), /owner token does not match/);
    await store.finishLegacyLease(successor.ownerToken);
  });

  it('keeps a killed legacy deployment locked for operator recovery', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const child = spawn(process.execPath, [
      ...inheritedModuleLoaderArgs(),
      join(REPO, 'manager/test/fixtures/releaseGuardHoldLegacy.ts'),
      root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (!child.killed) child.kill('SIGKILL'); });
    await waitForLockFixture(child);

    const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
    assert.equal(child.kill('SIGKILL'), true);
    await closed;
    assert.equal((await lstat(join(root, 'state.lock'))).isDirectory(), true);
    await assert.rejects(
      new ReleaseGuardStore(root).beginLegacyLease(),
      /crash lock requires operator recovery/,
    );
  });

  it('refuses a legacy lease after activation wins the ordering', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    const store = new ReleaseGuardStore(root);
    await verifiedReceipt(store, {
      slot: { role: 'manager', id: 'default' },
      artifact: {
        treeDigest: '4'.repeat(64),
        images: [{ service: 'api', imageId: IMAGE_ID }],
      },
    });

    assert.deepEqual(await store.beginLegacyLease(), { mode: 'managed' });
    await assert.rejects(lstat(join(root, 'state.lock')), /ENOENT/);
  });

  it('leases unrelated stack profiles after activation while protecting every installed target', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID, {
      manager: MANAGER_TARGET,
      admin: { projectName: 'admin-test', postgresVolumeName: 'admin-test-pg', webPort: 19_080 },
      uploader: UPLOADER_TARGET,
      viewer: VIEWER_TARGET,
    });
    const store = new ReleaseGuardStore(root);
    await verifiedReceipt(store, {
      slot: { role: 'manager', id: 'default' },
      artifact: {
        treeDigest: '4'.repeat(64),
        images: [{ service: 'api', imageId: IMAGE_ID }],
      },
    });

    for (const profile of ['manager-test', 'admin-test', 'managed', 'viewer']) {
      await assert.rejects(store.beginStackLegacyLease(profile), /protected by the installed release guard/);
    }
    const lease = await store.beginStackLegacyLease('unrelated-b');
    assert.match(lease.ownerToken, /^[0-9a-f-]{36}$/);
    await assert.rejects(store.withTransition(async () => undefined), /crash lock requires operator recovery/);
    await store.finishLegacyLease(lease.ownerToken);
    await assert.rejects(lstat(join(root, 'state.lock')), /ENOENT/);
  });
});

describe('guarded release transition', () => {
  it('refuses the actual pre-feature manager candidate before build or service movement', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    const archive = join(root, 'candidate.tar');
    await mkdir(candidate);
    const { stdout } = await execFileAsync('git', ['archive', '--format=tar', MANAGER_BASE], {
      cwd: REPO,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    await writeFile(archive, stdout);
    await execFileAsync('tar', ['-xf', archive, '-C', candidate]);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const counters = { build: 0, stop: 0, start: 0 };

    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(stateRoot),
        candidateRoot: candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: adapter(counters),
      }),
      /candidate does not advertise srsLifecycle version 1/,
    );
    assert.deepEqual(counters, { build: 0, stop: 0, start: 0 });
  });

  it('accepts the actual current capable manager candidate and moves its adapter once', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    const archive = join(root, 'candidate.tar');
    await mkdir(candidate);
    const { stdout } = await execFileAsync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: REPO,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    await writeFile(archive, stdout);
    await execFileAsync('tar', ['-xf', archive, '-C', candidate]);
    await mkdir(join(candidate, 'deploy'), { recursive: true });
    await copyFile(
      join(REPO, 'deploy/release-capabilities.json'),
      join(candidate, 'deploy/release-capabilities.json'),
    );
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const counters = { build: 0, stop: 0, start: 0 };

    await runReleaseTransition({
      store: new ReleaseGuardStore(stateRoot),
      candidateRoot: candidate,
      slot: { role: 'manager', id: 'default' },
      adapter: adapter(counters),
    });
    assert.deepEqual(counters, { build: 1, stop: 1, start: 1 });
  });

  it('binds the fsynced minimum, candidate tree, built image, and verified running image', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const counters = { build: 0, stop: 0, start: 0 };
    const releaseAdapter = adapter(counters);
    const move = releaseAdapter.transition;
    releaseAdapter.transition = async (plan) => {
      assert.deepEqual(
        JSON.parse(await readFile(join(stateRoot, 'managed-required.json'), 'utf8')),
        { schemaVersion: 1, installationId: INSTALLATION_ID },
      );
      await move(plan);
    };

    const result = await runReleaseTransition({
      store: new ReleaseGuardStore(stateRoot),
      candidateRoot: candidate,
      slot: { role: 'uploader', id: UPLOADER_ID },
      adapter: releaseAdapter,
    });

    assert.deepEqual(counters, { build: 1, stop: 1, start: 1 });
    assert.equal(result.receipt.artifact.images[0]?.imageId, IMAGE_ID);
    assert.match(result.receipt.artifact.treeDigest, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(stateRoot, 'pending', `${result.receipt.slot.role}-${result.receipt.slot.id}.json`), 'utf8'), result.body);
  });

  it('refuses capable uploader candidates whose effective managed settings are disabled or mismatched', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate);
    const adapterPath = join(candidate, 'deploy/scripts/release-adapter.sh');
    await mkdir(join(adapterPath, '..'), { recursive: true });
    await writeFile(adapterPath, `#!/bin/bash
set -euo pipefail
phase="$1"
case "$phase" in
  preflight) printf '%s\\n' '{"schemaVersion":1,"lifecycleVersion":0,"uploaderId":"other-uploader","adminApiConfigured":false}' > "$5" ;;
  build|verify) printf '%s\\n' '{"schemaVersion":1,"images":[{"service":"stream-uploader","imageId":"${IMAGE_ID}"}]}' > "$5" ;;
  transition) echo moved >> "$(dirname "$0")/movement" ;;
esac
`);
    await chmod(adapterPath, 0o700);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);

    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(stateRoot),
        candidateRoot: candidate,
        slot: { role: 'uploader', id: UPLOADER_ID },
        adapter: new FixedReleaseAdapter('uploader', join(root, 'adapter-work')),
      }),
      (error: Error) => {
        assert.match(error.message, /SRS_LIFECYCLE_VERSION/);
        assert.match(error.message, /SRS_UPLOADER_ID/);
        assert.match(error.message, /ADMIN_API_URL/);
        assert.doesNotMatch(error.message, /other-uploader/);
        return true;
      },
    );
    await assert.rejects(lstat(join(candidate, 'deploy/scripts/movement')), { code: 'ENOENT' });
    assert.equal((await new ReleaseGuardStore(stateRoot).read()).attempt, null);
  });

  it('proves removing preflight makes the old-candidate safety assertion fail', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await mkdir(candidate);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const counters = { build: 0, stop: 0, start: 0 };

    async function oldCandidateSafety(transition: typeof runReleaseTransition) {
      counters.build = 0;
      counters.stop = 0;
      counters.start = 0;
      await assert.rejects(
        transition({
          store: new ReleaseGuardStore(stateRoot),
          candidateRoot: candidate,
          slot: { role: 'manager', id: 'default' },
          adapter: adapter(counters),
        }),
      );
      assert.deepEqual(counters, { build: 0, stop: 0, start: 0 });
    }

    await oldCandidateSafety(runReleaseTransition);

    const mutantRoot = join(root, 'mutant');
    const sourceRoot = resolve(import.meta.dirname, '../../src/releaseGuard');
    await cp(sourceRoot, mutantRoot, { recursive: true });
    const mutantPath = join(mutantRoot, 'ReleaseTransition.ts');
    const source = await readFile(mutantPath, 'utf8');
    const withoutPreflight = source.replace(
      '  await requireLifecycleCapability(candidateRoot, input.slot.role);',
      '  void candidateRoot;',
    );
    assert.notEqual(withoutPreflight, source, 'the deliberate fault removed the production preflight call');
    await writeFile(mutantPath, withoutPreflight);
    const mutant = await import(`${pathToFileURL(mutantPath).href}?fault=missing-preflight`);

    await assert.rejects(
      oldCandidateSafety(mutant.runReleaseTransition as typeof runReleaseTransition),
      /Missing expected rejection|Expected values/,
    );
  });

  it('holds the host lease across transition and does not let a competitor overwrite it', async (t) => {
    const root = await temporaryRoot(t);
    const candidateA = join(root, 'candidate-a');
    const candidateB = join(root, 'candidate-b');
    await capableCandidate(candidateA);
    await capableCandidate(candidateB);
    await writeFile(join(candidateB, 'uploader.txt'), 'different candidate\n');
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const countersA = { build: 0, stop: 0, start: 0 };
    const countersB = { build: 0, stop: 0, start: 0 };
    let releaseA!: () => void;
    let enteredA!: () => void;
    const held = new Promise<void>((resolveHeld) => { releaseA = resolveHeld; });
    const entered = new Promise<void>((resolveEntered) => { enteredA = resolveEntered; });
    const adapterA = adapter(countersA);
    adapterA.transition = async () => {
      countersA.stop += 1;
      enteredA();
      await held;
      countersA.start += 1;
    };
    const store = new ReleaseGuardStore(stateRoot);
    const first = runReleaseTransition({
      store,
      candidateRoot: candidateA,
      slot: { role: 'uploader', id: UPLOADER_ID },
      adapter: adapterA,
    });
    await entered;

    await assert.rejects(
      runReleaseTransition({
        store,
        candidateRoot: candidateB,
        slot: { role: 'uploader', id: UPLOADER_ID },
        adapter: adapter(countersB),
      }),
      /another release guard transition is active/,
    );
    assert.deepEqual(countersB, { build: 0, stop: 0, start: 0 });

    releaseA();
    const firstReceipt = await first;
    assert.equal(
      await store.pendingReceipt({ role: 'uploader', id: UPLOADER_ID }),
      firstReceipt.body,
    );
  });

  it('keeps a prepared crash out of the submit-ready outbox and resumes only the bound artifact', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const store = new ReleaseGuardStore(stateRoot);
    const treeDigest = await digestTree(candidate);
    const artifact = {
      treeDigest,
      images: [{ service: 'stream-uploader', imageId: IMAGE_ID }],
    };
    const prepared = await store.withTransition((lease) => lease.prepare({
      slot: { role: 'uploader', id: UPLOADER_ID },
      artifact,
      transitionDigest: EMPTY_PREFLIGHT_TRANSITION_DIGEST,
    }));

    await assert.rejects(
      store.withTransition((lease) => lease.prepare({
        slot: { role: 'uploader', id: UPLOADER_ID },
        artifact,
        transitionDigest: 'e'.repeat(64),
      })),
      /release guard transition or receipt is unresolved/,
    );

    assert.equal(await store.pendingReceipt({ role: 'uploader', id: UPLOADER_ID }), null);
    await assert.rejects(
      submitPendingReceipt({
        store,
        slot: { role: 'uploader', id: UPLOADER_ID },
        adminUrl: 'http://127.0.0.1:1',
        token: 'test-only-internal-token-at-least-32-characters',
      }),
      /release receipt outbox is empty/,
    );

    const counters = { build: 0, stop: 0, start: 0 };
    const resumed = await runReleaseTransition({
      store,
      candidateRoot: candidate,
      slot: { role: 'uploader', id: UPLOADER_ID },
      adapter: adapter(counters),
    });
    assert.equal(resumed.body, prepared.body);
    assert.deepEqual(counters, { build: 1, stop: 1, start: 1 });
    assert.equal(await store.pendingReceipt({ role: 'uploader', id: UPLOADER_ID }), prepared.body);
  });

  it('writes immutable admin artifact metadata before activation and passes its exact path', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate, 'admin');
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    let activeArtifactPath: string | null = null;
    const adminImage = `sha256:${'9'.repeat(64)}`;
    const releaseAdapter: ReleaseAdapter = {
      async preflight() {},
      async build() {
        return { schemaVersion: 1, images: [{ service: 'admin', imageId: adminImage }] };
      },
      async transition(plan) {
        activeArtifactPath = plan.activeArtifactPath;
        assert.ok(activeArtifactPath, 'admin transition receives its immutable metadata path');
        const metadata = JSON.parse(await readFile(activeArtifactPath, 'utf8'));
        assert.deepEqual(metadata, {
          schemaVersion: 1,
          installationId: INSTALLATION_ID,
          generation: 1,
          slot: { role: 'admin', id: 'default' },
          artifact: {
            treeDigest: plan.treeDigest,
            images: [{ service: 'admin', imageId: adminImage }],
          },
        });
      },
      async verify() {
        return { schemaVersion: 1, images: [{ service: 'admin', imageId: adminImage }] };
      },
    };

    await runReleaseTransition({
      store: new ReleaseGuardStore(stateRoot),
      candidateRoot: candidate,
      slot: { role: 'admin', id: 'default' },
      adapter: releaseAdapter,
    });

    assert.ok(activeArtifactPath);
    assert.equal((await lstat(activeArtifactPath)).mode & 0o777, 0o444);
  });

  it('uses only the fixed role adapter and its bounded phase files', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate);
    const adapterPath = join(candidate, 'deploy/scripts/release-adapter.sh');
    await mkdir(join(adapterPath, '..'), { recursive: true });
    await writeFile(adapterPath, `#!/bin/bash
set -euo pipefail
if [ -n "\${RELEASE_GUARD_ADMIN_TOKEN:-}" ]; then exit 9; fi
phase="$1"
candidate="$(cd "$(dirname "$0")/../.." && pwd)"
echo "$phase" >> "$(dirname "$candidate")/phases"
case "$phase" in
  preflight) printf '%s\\n' '{"schemaVersion":1,"lifecycleVersion":1,"uploaderId":"${UPLOADER_ID}","adminApiConfigured":true,"fixtureNetworkId":"${FIXTURE_NETWORK_ID}","fixtureVolumeNames":["${UPLOADER_TARGET.profile}_srs-media","${UPLOADER_TARGET.profile}_uploader-state"]}' > "$5" ;;
  build|verify) printf '%s\\n' '{"schemaVersion":1,"images":[{"service":"stream-uploader","imageId":"${IMAGE_ID}"}]}' > "$5" ;;
  transition) ;;
  *) exit 7 ;;
esac
`);
    await chmod(adapterPath, 0o700);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);

    await runReleaseTransition({
      store: new ReleaseGuardStore(stateRoot),
      candidateRoot: candidate,
      slot: { role: 'uploader', id: UPLOADER_ID },
      adapter: new FixedReleaseAdapter('uploader', join(root, 'adapter-work'), {
        target: UPLOADER_TARGET,
        fixtureNetwork: FIXTURE_NETWORK,
      }),
    });

    assert.equal(await readFile(join(root, 'phases'), 'utf8'), 'preflight\nbuild\ntransition\nverify\n');
    const transitionPlan = JSON.parse(await readFile(join(root, 'adapter-work/transition-plan.json'), 'utf8'));
    assert.equal(transitionPlan.temporaryProject.startsWith('release-'), true);
    assert.equal(transitionPlan.activeArtifactPath, null);
    assert.deepEqual(transitionPlan.images, [{ service: 'stream-uploader', imageId: IMAGE_ID }]);
    assert.deepEqual(transitionPlan.arguments, {
      target: UPLOADER_TARGET,
      fixtureNetwork: { ...FIXTURE_NETWORK, networkId: FIXTURE_NETWORK_ID },
      fixtureVolumeNames: FIXTURE_VOLUME_NAMES,
    });
    assert.match((await new ReleaseGuardStore(stateRoot).read()).attempt?.transitionDigest ?? '', /^[0-9a-f]{64}$/);
  });

  it('routes only fixed role environment values into adapter processes', async (t) => {
    const root = await temporaryRoot(t);
    const names = [
      'POSTGRES_PASSWORD',
      'BEE_URL',
      'POSTAGE_BATCH_ID',
      'FEED_PRIVATE_KEY',
      'INTERNAL_API_TOKEN',
      'INGEST_SRT_PASSPHRASE',
      'ADMIN_API_URL',
      'ADMIN_API_TOKEN',
      'API_AUTH_TOKEN',
      'SRS_LIFECYCLE_VERSION',
      'SRS_MANAGED_UPLOADER_PROFILE',
      'RELEASE_GUARD_ADMIN_TOKEN',
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `test-only-${name.toLowerCase()}`;
    t.after(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const admin = join(root, 'admin');
    await capableCandidate(admin, 'admin');
    const adminAdapter = join(admin, 'web2-admin/backend/release-adapter.sh');
    await mkdir(dirname(adminAdapter), { recursive: true });
    await writeFile(adminAdapter, `#!/bin/bash
set -euo pipefail
[ -z "\${RELEASE_GUARD_ADMIN_TOKEN:-}" ]
[ -z "\${ADMIN_API_TOKEN:-}" ]
for name in POSTGRES_PASSWORD BEE_URL POSTAGE_BATCH_ID FEED_PRIVATE_KEY INTERNAL_API_TOKEN INGEST_SRT_PASSPHRASE; do
  [ -n "\${!name:-}" ]
done
printf '%s\\n' '{"schemaVersion":1}' > "$5"
`);
    await chmod(adminAdapter, 0o700);
    await new FixedReleaseAdapter('admin', join(root, 'admin-work'), { target: MANAGER_TARGET }).preflight({
      candidateRoot: admin,
      treeDigest: 'a'.repeat(64),
      slot: { role: 'admin', id: 'default' },
    });

    const uploader = join(root, 'uploader');
    await capableCandidate(uploader);
    const uploaderAdapter = join(uploader, 'deploy/scripts/release-adapter.sh');
    await mkdir(dirname(uploaderAdapter), { recursive: true });
    await writeFile(uploaderAdapter, `#!/bin/bash
set -euo pipefail
[ -z "\${RELEASE_GUARD_ADMIN_TOKEN:-}" ]
[ -z "\${POSTGRES_PASSWORD:-}" ]
for name in ADMIN_API_URL ADMIN_API_TOKEN API_AUTH_TOKEN; do
  [ -n "\${!name:-}" ]
done
printf '%s\\n' '{"schemaVersion":1,"lifecycleVersion":1,"uploaderId":"${UPLOADER_ID}","adminApiConfigured":true}' > "$5"
`);
    await chmod(uploaderAdapter, 0o700);
    await new FixedReleaseAdapter('uploader', join(root, 'uploader-work'), { target: UPLOADER_TARGET }).preflight({
      candidateRoot: uploader,
      treeDigest: 'b'.repeat(64),
      slot: { role: 'uploader', id: UPLOADER_ID },
    });

    const manager = join(root, 'manager');
    await capableCandidate(manager, 'manager');
    const managerAdapter = join(manager, 'deploy/release-adapters/manager.sh');
    await mkdir(dirname(managerAdapter), { recursive: true });
    await writeFile(managerAdapter, `#!/bin/bash
set -euo pipefail
[ -z "\${RELEASE_GUARD_ADMIN_TOKEN:-}" ]
[ -z "\${API_AUTH_TOKEN:-}" ]
for name in POSTGRES_PASSWORD SRS_LIFECYCLE_VERSION SRS_MANAGED_UPLOADER_PROFILE ADMIN_API_URL ADMIN_API_TOKEN; do
  [ -n "\${!name:-}" ]
done
printf '%s\\n' '{"schemaVersion":1}' > "$5"
`);
    await chmod(managerAdapter, 0o700);
    await new FixedReleaseAdapter('manager', join(root, 'manager-work'), { target: MANAGER_TARGET }).preflight({
      candidateRoot: manager,
      treeDigest: 'c'.repeat(64),
      slot: { role: 'manager', id: 'default' },
    });
  });

  it('builds and activates manager images by immutable id without replacing live tags', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate, 'manager');
    await mkdir(join(candidate, 'manager'), { recursive: true });
    await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
    await writeFile(join(candidate, 'manager/.env'), 'MANAGER_DOMAIN=manager.example.test\n');
    await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
    await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
    await copyFile(
      join(REPO, 'deploy/release-adapters/manager.sh'),
      join(candidate, 'deploy/release-adapters/manager.sh'),
    );
    await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin);
    const docker = join(fakeBin, 'docker');
    await writeFile(docker, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$(dirname "$0")/docker.log"
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "\${!#}" in
    *-api) printf '%s\\n' '${IMAGE_ID}' ;;
    *-web) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
    *) exit 31 ;;
  esac
elif [ "$1" = compose ] && [ "\${!#}" = api ]; then
  printf '%s\\n' manager-api-container
elif [ "$1" = compose ] && [ "\${!#}" = web ]; then
  printf '%s\\n' manager-web-container
elif [ "$1" = compose ] && [ "\${!#}" = postgres ]; then
  printf '%s\\n' manager-postgres-container
elif [ "$1" = inspect ]; then
  if [[ "$*" == *State.Status* ]]; then
    printf '%s\\n' running
  elif [[ "$*" == *State.Health.Status* ]]; then
    printf '%s\\n' healthy
  elif [[ "$*" == *Mounts* ]]; then
    case "$*" in
      *manager-postgres-container) printf '%s\\n' '${MANAGER_TARGET.postgresVolumeName}' ;;
      *'/root/.ssh'*) printf '%s\\n' "\${HOME}/manager-ssh" ;;
      *streaming-infra-manager-data*) printf '%s\\n' "\${HOME}/streaming-infra-manager-data" ;;
      *streaming-infra-manager-versions*) printf '%s\\n' "\${HOME}/streaming-infra-manager-versions" ;;
      *) printf '%s\\n' "$(cd "$(dirname "$0")/.." && pwd -P)/candidate" ;;
    esac
  else
    case "\${!#}" in
      manager-api-container) printf '%s\\n' '${IMAGE_ID}' ;;
      manager-web-container) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
      *) exit 32 ;;
    esac
  fi
fi
`);
    await chmod(docker, 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    t.after(() => { process.env.PATH = oldPath; });
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);

    const result = await runReleaseTransition({
      store: new ReleaseGuardStore(stateRoot),
      candidateRoot: candidate,
      slot: { role: 'manager', id: 'default' },
      adapter: new FixedReleaseAdapter('manager', join(root, 'adapter-work'), { target: MANAGER_TARGET }),
    });

    assert.deepEqual(result.receipt.artifact.images, [
      { service: 'api', imageId: IMAGE_ID },
      { service: 'web', imageId: WEB_IMAGE_ID },
    ]);
    const calls = await readFile(join(fakeBin, 'docker.log'), 'utf8');
    assert.match(calls, /--project-name release-[0-9a-f]{20} .* build api web/);
    assert.match(calls, /--project-name manager-test .*manager-image-override\.yml run --rm --no-deps -T api node dist\/cli\.js manager:upgrade/);
    assert.match(calls, /--compose-override .*manager-image-override\.yml/);
    assert.match(calls, /--public-edge/);
    assert.doesNotMatch(calls, /image tag|--project-name manager-test .* build/);
    const override = await readFile(join(root, 'adapter-work/manager-image-override.yml'), 'utf8');
    const transitionPlan = JSON.parse(await readFile(join(root, 'adapter-work/transition-plan.json'), 'utf8'));
    const guardedCandidate = transitionPlan.candidateRoot as string;
    const guardedWork = join(dirname(guardedCandidate), 'adapter-work');
    assert.match(override, new RegExp(`image: ${IMAGE_ID}`));
    assert.match(override, new RegExp(`image: ${WEB_IMAGE_ID}`));
    assert.equal(override.match(/pull_policy: never/g)?.length, 2);
    assert.match(override, /WEB_PORT: "18080"/);
    assert.match(override, /volumes:\n  manager-pg:\n    name: manager-test-pg/);
    assert.match(override, new RegExp(`source: ${guardedCandidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(override, new RegExp(`target: ${guardedCandidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(override, new RegExp(`SHLS_ROOT: ${join(guardedCandidate, 'manager/swarm-hls-stream').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(override, new RegExp(`source: ${guardedWork.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(override, new RegExp(`target: ${guardedWork.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(calls, /inspect --format .*State\.Status.*manager-api-container/);
    assert.match(calls, /inspect --format .*State\.Status.*manager-web-container/);
    assert.match(calls, /inspect --format .*State\.Health\.Status.*manager-web-container/);
    assert.match(calls, /inspect --format .*Mounts.*manager-postgres-container/);
    assert.match(calls, /inspect --format .*Mounts.*manager-api-container/);
  });

  it('refuses a manager whose postgres container mounted a different volume', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await mkdir(join(candidate, 'manager'), { recursive: true });
    await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
    await writeFile(join(candidate, 'manager/.env'), 'MANAGER_DOMAIN=\n');
    await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
    await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
    await copyFile(
      join(REPO, 'deploy/release-adapters/manager.sh'),
      join(candidate, 'deploy/release-adapters/manager.sh'),
    );
    await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin);
    const docker = join(fakeBin, 'docker');
    await writeFile(docker, `#!/bin/bash
set -euo pipefail
if [ "$1" = compose ]; then
  case "\${!#}" in
    api) printf '%s\\n' manager-api-container ;;
    web) printf '%s\\n' manager-web-container ;;
    postgres) printf '%s\\n' manager-postgres-container ;;
  esac
elif [[ "$*" == *State.Status* ]]; then
  printf '%s\\n' running
elif [[ "$*" == *State.Health.Status* ]]; then
  printf '%s\\n' healthy
elif [[ "$*" == *Mounts* ]]; then
  printf '%s\\n' manager-test_manager-pg
elif [ "$1" = inspect ]; then
  case "\${!#}" in
    manager-api-container) printf '%s\\n' '${IMAGE_ID}' ;;
    manager-web-container) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
  esac
fi
`);
    await chmod(docker, 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    t.after(() => { process.env.PATH = oldPath; });

    await assert.rejects(
      new FixedReleaseAdapter('manager', join(root, 'adapter-work'), { target: MANAGER_TARGET }).verify({
        candidateRoot: await realpath(candidate),
        treeDigest: 'a'.repeat(64),
        slot: { role: 'manager', id: 'default' },
        images: [
          { service: 'api', imageId: IMAGE_ID },
          { service: 'web', imageId: WEB_IMAGE_ID },
        ],
        activeArtifactPath: null,
      }),
      /release adapter verify failed/,
    );
  });

  it('refuses an isolated public edge or occupied port before the upgrade coordinator', async (t) => {
    async function candidateWithDocker(root: string, managerDomain: string) {
      const candidate = join(root, 'candidate');
      await capableCandidate(candidate, 'manager');
      await mkdir(join(candidate, 'manager'), { recursive: true });
      await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
      await writeFile(join(candidate, 'manager/.env'), `MANAGER_DOMAIN=${managerDomain}\n`);
      await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
      await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
      await copyFile(
        join(REPO, 'deploy/release-adapters/manager.sh'),
        join(candidate, 'deploy/release-adapters/manager.sh'),
      );
      await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
      const fakeBin = join(root, 'bin');
      await mkdir(fakeBin);
      const docker = join(fakeBin, 'docker');
      await writeFile(docker, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$(dirname "$0")/docker.log"
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "\${!#}" in
    *-api) printf '%s\\n' '${IMAGE_ID}' ;;
    *-web) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
  esac
fi
`);
      await chmod(docker, 0o700);
      return { candidate, fakeBin };
    }

    const edgeRoot = await temporaryRoot(t);
    const edge = await candidateWithDocker(edgeRoot, 'manager.example.test');
    const oldPath = process.env.PATH;
    process.env.PATH = `${edge.fakeBin}:${oldPath ?? ''}`;
    t.after(() => { process.env.PATH = oldPath; });
    const edgeState = join(edgeRoot, 'state');
    await installReleaseGuard(edgeState, INSTALLATION_ID);
    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(edgeState),
        candidateRoot: edge.candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: new FixedReleaseAdapter('manager', join(edgeRoot, 'adapter-work'), {
          target: ISOLATED_MANAGER_TARGET,
        }),
      }),
      /release adapter transition failed/,
    );
    assert.doesNotMatch(await readFile(join(edge.fakeBin, 'docker.log'), 'utf8'), /manager:upgrade/);

    const occupiedRoot = await temporaryRoot(t);
    const occupied = await candidateWithDocker(occupiedRoot, '');
    process.env.PATH = `${occupied.fakeBin}:${oldPath ?? ''}`;
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: '127.0.0.1', port: 0 }, resolveListen);
    });
    t.after(async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const occupiedTarget = {
      ...ISOLATED_MANAGER_TARGET,
      postgresPort: address.port,
      webPort: address.port === 65_535 ? 65_534 : address.port + 1,
    };
    const occupiedState = join(occupiedRoot, 'state');
    await installReleaseGuard(occupiedState, INSTALLATION_ID);
    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(occupiedState),
        candidateRoot: occupied.candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: new FixedReleaseAdapter('manager', join(occupiedRoot, 'adapter-work'), {
          target: occupiedTarget,
        }),
      }),
      /release adapter transition failed/,
    );
    assert.doesNotMatch(await readFile(join(occupied.fakeBin, 'docker.log'), 'utf8'), /manager:upgrade/);
  });

  it('refuses a manager whose pinned web container is not healthy', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await mkdir(join(candidate, 'manager'), { recursive: true });
    await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
    await writeFile(join(candidate, 'manager/.env'), 'MANAGER_DOMAIN=\n');
    await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
    await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
    await copyFile(
      join(REPO, 'deploy/release-adapters/manager.sh'),
      join(candidate, 'deploy/release-adapters/manager.sh'),
    );
    await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin);
    const docker = join(fakeBin, 'docker');
    await writeFile(docker, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$(dirname "$0")/docker.log"
if [ "$1" = compose ] && [ "\${!#}" = api ]; then
  printf '%s\\n' manager-api-container
elif [ "$1" = compose ] && [ "\${!#}" = web ]; then
  printf '%s\\n' manager-web-container
elif [ "$1" = compose ] && [ "\${!#}" = postgres ]; then
  printf '%s\\n' manager-postgres-container
elif [[ "$*" == *State.Status* ]]; then
  printf '%s\\n' running
elif [[ "$*" == *State.Health.Status* ]]; then
  printf '%s\\n' unhealthy
elif [ "$1" = inspect ]; then
  case "\${!#}" in
    manager-api-container) printf '%s\\n' '${IMAGE_ID}' ;;
    manager-web-container) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
  esac
fi
`);
    await chmod(docker, 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    t.after(() => { process.env.PATH = oldPath; });

    await assert.rejects(
      new FixedReleaseAdapter('manager', join(root, 'adapter-work'), { target: MANAGER_TARGET }).verify({
        candidateRoot: await realpath(candidate),
        treeDigest: 'a'.repeat(64),
        slot: { role: 'manager', id: 'default' },
        images: [
          { service: 'api', imageId: IMAGE_ID },
          { service: 'web', imageId: WEB_IMAGE_ID },
        ],
        activeArtifactPath: null,
      }),
      /release adapter verify failed/,
    );
    assert.match(
      await readFile(join(fakeBin, 'docker.log'), 'utf8'),
      /inspect --format .*State\.Health\.Status.*manager-web-container/,
    );
  });

  it('does not start the new manager outside the coordinator when its migration fails', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate, 'manager');
    await mkdir(join(candidate, 'manager'), { recursive: true });
    await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
    await writeFile(join(candidate, 'manager/.env'), 'MANAGER_DOMAIN=\n');
    await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
    await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
    await copyFile(
      join(REPO, 'deploy/release-adapters/manager.sh'),
      join(candidate, 'deploy/release-adapters/manager.sh'),
    );
    await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin);
    const docker = join(fakeBin, 'docker');
    await writeFile(docker, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$(dirname "$0")/docker.log"
if [ "$1" = image ]; then
  case "\${!#}" in
    *-api) printf '%s\\n' '${IMAGE_ID}' ;;
    *-web) printf '%s\\n' '${WEB_IMAGE_ID}' ;;
  esac
elif [[ "$*" == *manager:upgrade* ]]; then
  echo 'manager upgrade failed during migration' >&2
  exit 42
fi
`);
    await chmod(docker, 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    t.after(() => { process.env.PATH = oldPath; });
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);

    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(stateRoot),
        candidateRoot: candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: new FixedReleaseAdapter('manager', join(root, 'adapter-work'), { target: MANAGER_TARGET }),
      }),
      /release adapter transition failed with exit 42/,
    );

    const calls = await readFile(join(fakeBin, 'docker.log'), 'utf8');
    assert.match(calls, /manager:upgrade/);
    assert.doesNotMatch(calls, /up -d/);
    assert.equal((await new ReleaseGuardStore(stateRoot).read()).attempt?.phase, 'prepared');
  });

  it('kills the adapter process group on timeout without surfacing captured output', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate);
    const adapterPath = join(candidate, 'deploy/scripts/release-adapter.sh');
    await mkdir(join(adapterPath, '..'), { recursive: true });
    await writeFile(adapterPath, `#!/bin/bash
set -euo pipefail
phase="$1"
candidate="$(cd "$(dirname "$0")/../.." && pwd)"
case "$phase" in
  preflight) printf '%s\\n' '{"schemaVersion":1,"lifecycleVersion":1,"uploaderId":"${UPLOADER_ID}","adminApiConfigured":true}' > "$5" ;;
  build) printf '%s\\n' '{"schemaVersion":1,"images":[{"service":"stream-uploader","imageId":"${IMAGE_ID}"}]}' > "$5" ;;
  transition)
    echo '{"POSTGRES_PASSWORD":"stdout-sentinel"}'
    printf '%s\n' 'compose transition refused "ADMIN_API_TOKEN=stderr-sentinel"' >&2
    (sleep 0.4; echo late > "$(dirname "$candidate")/late-write") &
    sleep 5
    ;;
  verify) exit 8 ;;
esac
`);
    await chmod(adapterPath, 0o700);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const store = new ReleaseGuardStore(stateRoot);

    await assert.rejects(
      runReleaseTransition({
        store,
        candidateRoot: candidate,
        slot: { role: 'uploader', id: UPLOADER_ID },
        adapter: new FixedReleaseAdapter('uploader', join(root, 'adapter-work'), {}, 100),
      }),
      (error: Error) => {
        assert.match(error.message, /release adapter transition timed out \(stdout \d+ bytes, stderr \d+ bytes\)/);
        assert.doesNotMatch(error.message, /stdout-sentinel|stderr-sentinel|POSTGRES_PASSWORD|ADMIN_API_TOKEN/);
        return true;
      },
    );
    assert.equal((await store.read()).attempt?.phase, 'prepared');
    await delay(600);
    await assert.rejects(lstat(join(root, 'late-write')), { code: 'ENOENT' });
  });
});

describe('installed release guard command', () => {
  it('installs a typed isolated manager target through the fixed command', async (t) => {
    const root = await temporaryRoot(t);
    await runReleaseGuardCli([
      'install',
      '--state-root', root,
      '--manager-mode', 'isolated',
      '--manager-project-name', ISOLATED_MANAGER_TARGET.projectName,
      '--manager-postgres-volume-name', ISOLATED_MANAGER_TARGET.postgresVolumeName,
      '--manager-postgres-port', String(ISOLATED_MANAGER_TARGET.postgresPort),
      '--manager-web-port', String(ISOLATED_MANAGER_TARGET.webPort),
      '--uploader-profile', UPLOADER_TARGET.profile,
      '--uploader-port-slot', String(UPLOADER_TARGET.portSlot),
      '--uploader-services', UPLOADER_TARGET.services.join(','),
      '--viewer-profile', VIEWER_TARGET.profile,
      '--viewer-port-slot', String(VIEWER_TARGET.portSlot),
      '--viewer-services', VIEWER_TARGET.services.join(','),
      '--fixture-network-name', FIXTURE_NETWORK.name,
      '--fixture-id', FIXTURE_NETWORK.fixtureId,
    ], {});

    const store = new ReleaseGuardStore(root);
    assert.deepEqual(await store.deploymentTarget('manager'), ISOLATED_MANAGER_TARGET);
    assert.deepEqual(await store.deploymentTarget('uploader'), UPLOADER_TARGET);
    assert.deepEqual(await store.deploymentTarget('viewer'), VIEWER_TARGET);
    assert.deepEqual(await store.fixtureNetwork(), FIXTURE_NETWORK);
  });

  it('reports only the durable release mode', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);
    assert.equal(await runReleaseGuardCli(['status', '--state-root', root], {}), 'legacy');
  });

  it('exposes an owner-bound legacy lease through fixed commands', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID);

    const result = await runReleaseGuardCli(['begin-legacy', '--state-root', root], {});
    assert.match(result, /^legacy:[0-9a-f-]{36}$/);
    const ownerToken = result.slice('legacy:'.length);
    await assert.rejects(
      runReleaseGuardCli([
        'finish-legacy',
        '--state-root', root,
        '--owner-token', '22222222-2222-4222-8222-222222222222',
      ], {}),
      /owner token does not match/,
    );
    assert.equal(
      await runReleaseGuardCli([
        'finish-legacy',
        '--state-root', root,
        '--owner-token', ownerToken,
      ], {}),
      'legacy deployment lease released',
    );
  });

  it('exposes an owner-bound unrelated stack lease through fixed commands', async (t) => {
    const root = await temporaryRoot(t);
    await installReleaseGuard(root, INSTALLATION_ID, { uploader: UPLOADER_TARGET });

    await assert.rejects(
      runReleaseGuardCli(['begin-stack-legacy', '--state-root', root, '--profile', UPLOADER_TARGET.profile], {}),
      /protected by the installed release guard/,
    );
    const result = await runReleaseGuardCli([
      'begin-stack-legacy',
      '--state-root', root,
      '--profile', 'unrelated-b',
    ], {});
    assert.match(result, /^legacy:[0-9a-f-]{36}$/);
    assert.equal(
      await runReleaseGuardCli([
        'finish-stack-legacy',
        '--state-root', root,
        '--owner-token', result.slice('legacy:'.length),
      ], {}),
      'legacy stack deployment lease released',
    );
  });

  it('digests one staged candidate without changing guard state', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableCandidate(candidate, 'manager');

    const digest = await runReleaseGuardCli(['digest', '--candidate-root', candidate], {});

    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, await digestTree(resolve(candidate)));
  });

  it('offers only fixed component roles and installation-bound stack arguments', async () => {
    await assert.rejects(runReleaseGuardCli(['shell', '--command', 'docker stop all']), /command is invalid/);
    await assert.rejects(
      runReleaseGuardCli([
        'manager',
        '--state-root', '/tmp/state',
        '--candidate-root', '/tmp/candidate',
        '--work-root', '/tmp/work',
        '--admin-url', 'http://admin',
        '--profile', 'stage',
      ], { RELEASE_GUARD_ADMIN_TOKEN: 'x'.repeat(32) }),
      /argument --profile is not supported/,
    );
    await assert.rejects(
      runReleaseGuardCli([
        'uploader',
        '--state-root', '/tmp/state',
        '--candidate-root', '/tmp/candidate',
        '--work-root', '/tmp/work',
        '--admin-url', 'http://admin',
        '--slot-id', 'srs/uploader',
        '--profile', 'stage',
        '--port-slot', '1',
        '--target', 'local',
        '--services', 'srs,stream-uploader',
      ], { RELEASE_GUARD_ADMIN_TOKEN: 'x'.repeat(32) }),
      /argument --profile is not supported/,
    );
  });

  it('validates receipt credentials before invoking a release adapter', async (t) => {
    for (const [name, adminUrl, env, expected] of [
      ['missing-token', 'http://admin', {}, /RELEASE_GUARD_ADMIN_TOKEN/],
      ['invalid-url', 'ftp://admin', { RELEASE_GUARD_ADMIN_TOKEN: 'x'.repeat(32) }, /admin URL is invalid/],
    ] as const) {
      const root = join(await temporaryRoot(t), name);
      const candidate = join(root, 'candidate');
      const stateRoot = join(root, 'state');
      const workRoot = join(root, 'work');
      const called = join(root, 'adapter-called');
      await capableCandidate(candidate, 'manager');
      await mkdir(join(candidate, 'deploy/release-adapters'), { recursive: true });
      await writeFile(join(candidate, 'deploy/release-adapters/manager.sh'), `#!/bin/bash
set -euo pipefail
touch '${called}'
case "$1" in
  preflight) printf '%s\\n' '{"schemaVersion":1}' > "$5" ;;
  build|verify) printf '%s\\n' '{"schemaVersion":1,"images":[{"service":"api","imageId":"${IMAGE_ID}"}]}' > "$5" ;;
esac
`);
      await chmod(join(candidate, 'deploy/release-adapters/manager.sh'), 0o700);
      await installReleaseGuard(stateRoot, INSTALLATION_ID);

      await assert.rejects(runReleaseGuardCli([
        'manager',
        '--state-root', stateRoot,
        '--candidate-root', candidate,
        '--work-root', workRoot,
        '--admin-url', adminUrl,
      ], env), expected);
      await assert.rejects(lstat(called), { code: 'ENOENT' });
    }
  });
});

describe('release receipt outbox', () => {
  it('retries the exact durable body after response loss without exposing the bearer', async (t) => {
    const root = await temporaryRoot(t);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const store = new ReleaseGuardStore(stateRoot);
    const pending = await verifiedReceipt(store, {
      slot: { role: 'viewer', id: 'default' },
      artifact: {
        treeDigest: 'e'.repeat(64),
        images: [{ service: 'client', imageId: `sha256:${'f'.repeat(64)}` }],
      },
    });
    const bodies: string[] = [];
    const authorizations: string[] = [];
    const targets: string[] = [];
    let loseFirstResponse = true;
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        bodies.push(body);
        authorizations.push(request.headers.authorization ?? '');
        targets.push(`${request.method} ${request.url}`);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          request.socket.destroy();
          return;
        }
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const adminUrl = `http://127.0.0.1:${address.port}`;
    const token = 'test-only-internal-token-at-least-32-characters';

    await assert.rejects(
      submitPendingReceipt({ store, slot: { role: 'viewer', id: 'default' }, adminUrl, token }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /test-only|token/i);
        return true;
      },
    );
    assert.equal(await store.pendingReceipt({ role: 'viewer', id: 'default' }), pending.body);

    await submitPendingReceipt({ store, slot: { role: 'viewer', id: 'default' }, adminUrl, token });
    assert.deepEqual(bodies, [pending.body, pending.body]);
    assert.deepEqual(authorizations, [`Bearer ${token}`, `Bearer ${token}`]);
    assert.deepEqual(targets, [
      'PUT /api/internal/release-guard/receipts/viewer/default',
      'PUT /api/internal/release-guard/receipts/viewer/default',
    ]);
    assert.equal(await store.pendingReceipt({ role: 'viewer', id: 'default' }), null);
  });

  it('refuses redirects and oversized responses while retaining the outbox', async (t) => {
    const root = await temporaryRoot(t);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const store = new ReleaseGuardStore(stateRoot);
    await verifiedReceipt(store, {
      slot: { role: 'admin', id: 'default' },
      artifact: {
        treeDigest: '1'.repeat(64),
        images: [{ service: 'admin', imageId: `sha256:${'2'.repeat(64)}` }],
      },
    });
    let redirected = false;
    let mode: 'redirect' | 'oversized' = 'redirect';
    const server = http.createServer((request, response) => {
      if (request.url === '/redirected') {
        redirected = true;
        response.writeHead(204).end();
        return;
      }
      if (mode === 'redirect') {
        response.writeHead(302, { location: '/redirected' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(20_000));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const adminUrl = `http://127.0.0.1:${address.port}`;
    const input = {
      store,
      slot: { role: 'admin', id: 'default' } as const,
      adminUrl,
      token: 'test-only-internal-token-at-least-32-characters',
    };

    await assert.rejects(submitPendingReceipt(input), /release receipt submission failed/);
    assert.equal(redirected, false);
    mode = 'oversized';
    await assert.rejects(submitPendingReceipt(input), /release receipt response is oversized/);
    assert.ok(await store.pendingReceipt(input.slot));
  });
});
