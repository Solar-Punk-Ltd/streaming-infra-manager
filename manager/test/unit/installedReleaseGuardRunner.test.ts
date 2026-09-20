import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  InstalledReleaseGuardRunner,
  type InstalledReleaseRoute,
} from '../../src/domain/InstalledReleaseGuardRunner.js';
import type {
  RunHandle,
  RunOptions,
  ScriptSpawner,
} from '../../src/domain/ScriptRunner.js';
import { installReleaseGuard } from '../../src/releaseGuard/ReleaseGuardStore.js';

import { FakeScriptRunner } from '../support/FakeScriptRunner.js';

const ADMIN = {
  lifecycleVersion: 1 as const,
  profile: 'managed',
  adminApiUrl: 'http://admin.internal:9877',
  adminApiToken: 'synthetic-token-with-at-least-32-bytes',
};

async function installed(
  targets: Parameters<typeof installReleaseGuard>[2],
): Promise<{ runner: InstalledReleaseGuardRunner; child: FakeScriptRunner; stateRoot: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'installed-release-runner-'));
  await installReleaseGuard(stateRoot, undefined, targets);
  const child = new FakeScriptRunner();
  return {
    runner: new InstalledReleaseGuardRunner(child, stateRoot),
    child,
    stateRoot,
  };
}

function guarded(route: InstalledReleaseRoute): Extract<InstalledReleaseRoute, { kind: 'guard' }> {
  assert.equal(route.kind, 'guard');
  return route as Extract<InstalledReleaseRoute, { kind: 'guard' }>;
}

class ControlledSpawner implements ScriptSpawner {
  readonly handles: Array<RunHandle & { killed: number }> = [];

  run(_script: string, _args: string[], _options?: RunOptions): RunHandle {
    const emitter = new EventEmitter();
    const handle = {
      emitter,
      killed: 0,
      kill: () => { handle.killed += 1; },
    };
    this.handles.push(handle);
    return handle;
  }
}

describe('installed release guard runner', () => {
  it('routes an exact uploader target through installed code with process-only credentials', async () => {
    const { runner, child, stateRoot } = await installed({
      uploader: {
        profile: 'managed',
        portSlot: 4,
        target: 'local',
        services: ['srs', 'stream-uploader'],
      },
    });
    const route = guarded(await runner.route({
      profile: 'managed',
      portSlot: 4,
      uploaderId: 'srs-uploader-a',
      services: ['srs', 'stream-uploader'],
      candidateRoot: '/candidate/managed',
      lifecycle: ADMIN,
    }));

    assert.equal(route.includesUploader, true);
    assert.deepEqual(route.roles, ['uploader']);
    runner.run(route, { cwd: '/candidate/managed' });

    assert.equal(child.runs.length, 1);
    assert.equal(
      child.runs[0]!.script,
      '/opt/streaming-release-guard/streaming-release-guard',
    );
    assert.deepEqual(child.runs[0]!.args, [
      'uploader',
      '--state-root', stateRoot,
      '--candidate-root', '/candidate/managed',
      '--work-root', join(stateRoot, 'manager-work', 'managed', 'uploader'),
      '--admin-url', ADMIN.adminApiUrl,
      '--slot-id', 'srs-uploader-a',
    ]);
    assert.equal(child.runs[0]!.options.withholdOutput, true);
    assert.deepEqual(child.runs[0]!.options.env, {
      ADMIN_API_TOKEN: ADMIN.adminApiToken,
      ADMIN_API_URL: ADMIN.adminApiUrl,
      RELEASE_GUARD_ADMIN_TOKEN: ADMIN.adminApiToken,
      RELEASE_GUARD_ADMIN_URL: ADMIN.adminApiUrl,
    });
    assert.doesNotMatch(JSON.stringify(child.runs[0]!.args), /synthetic-token/);
  });

  it('identifies a held-back protected uploader for a guard-owned preparation', async () => {
    const { runner, child } = await installed({
      uploader: {
        profile: 'managed',
        portSlot: 4,
        target: 'local',
        services: ['bee-uploader', 'srs', 'stream-uploader'],
      },
    });

    const route = await runner.route({
      profile: 'managed',
      portSlot: 4,
      uploaderId: 'srs-uploader-a',
      services: ['bee-uploader', 'srs'],
      candidateRoot: '/candidate/managed',
      lifecycle: ADMIN,
    });

    assert.deepEqual(route, {
      kind: 'protected-subset',
      role: 'uploader',
      operation: 'prepare',
    });
    assert.equal(child.runs.length, 0);
  });

  it('routes an installed viewer target and sequences viewer before uploader', async () => {
    const { runner, child } = await installed({
      uploader: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['srs', 'stream-uploader'],
      },
      viewer: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['client'],
      },
    });
    const route = guarded(await runner.route({
      profile: 'combined',
      portSlot: 7,
      uploaderId: 'srs-uploader-a',
      services: ['client', 'srs', 'stream-uploader'],
      candidateRoot: '/candidate/combined',
      lifecycle: { ...ADMIN, profile: 'combined' },
    }));

    assert.deepEqual(route.roles, ['viewer', 'uploader']);
    const handle = runner.run(route, { cwd: '/candidate/combined' });
    const outcomes: unknown[] = [];
    handle.emitter.on('done', (outcome) => outcomes.push(outcome));
    assert.equal(child.runs[0]!.args[0], 'viewer');
    child.finish(0);
    assert.equal(child.runs[1]!.args[0], 'uploader');
    child.finish(1);
    assert.deepEqual(outcomes, [{ code: 0, signal: null }]);
  });

  it('does not start a later guarded role after the composite run is cancelled', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'installed-release-runner-'));
    await installReleaseGuard(stateRoot, undefined, {
      uploader: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['srs', 'stream-uploader'],
      },
      viewer: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['client'],
      },
    });
    const child = new ControlledSpawner();
    const runner = new InstalledReleaseGuardRunner(child, stateRoot);
    const route = guarded(await runner.route({
      profile: 'combined',
      portSlot: 7,
      uploaderId: 'srs-uploader-a',
      services: ['client', 'srs', 'stream-uploader'],
      candidateRoot: '/candidate/combined',
      lifecycle: { ...ADMIN, profile: 'combined' },
    }));
    const handle = runner.run(route, { cwd: '/candidate/combined' });
    const outcomes: unknown[] = [];
    handle.emitter.on('done', (outcome) => outcomes.push(outcome));

    handle.kill();
    child.handles[0]!.emitter.emit('done', { code: 0, signal: null });

    assert.equal(child.handles[0]!.killed, 1);
    assert.equal(child.handles.length, 1);
    assert.deepEqual(outcomes, [{ code: -1, signal: 'SIGTERM' }]);
  });

  it('does not start a later guarded role after an error and a late done event', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'installed-release-runner-'));
    await installReleaseGuard(stateRoot, undefined, {
      uploader: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['srs', 'stream-uploader'],
      },
      viewer: {
        profile: 'combined',
        portSlot: 7,
        target: 'local',
        services: ['client'],
      },
    });
    const child = new ControlledSpawner();
    const runner = new InstalledReleaseGuardRunner(child, stateRoot);
    const route = guarded(await runner.route({
      profile: 'combined',
      portSlot: 7,
      uploaderId: 'srs-uploader-a',
      services: ['client', 'srs', 'stream-uploader'],
      candidateRoot: '/candidate/combined',
      lifecycle: { ...ADMIN, profile: 'combined' },
    }));
    const handle = runner.run(route, { cwd: '/candidate/combined' });
    const errors: Error[] = [];
    handle.emitter.on('error', (error) => errors.push(error));

    child.handles[0]!.emitter.emit('error', new Error('viewer failed'));
    child.handles[0]!.emitter.emit('done', { code: 0, signal: null });

    assert.equal(child.handles.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /viewer failed/);
  });

  it('routes an unrelated profile through the scoped legacy stack path', async () => {
    const { runner } = await installed({
      viewer: {
        profile: 'viewer-a',
        portSlot: 2,
        target: 'local',
        services: ['client'],
      },
    });

    assert.deepEqual(await runner.route({
      profile: 'unrelated',
      portSlot: 3,
      uploaderId: 'unrelated-id',
      services: ['client'],
      candidateRoot: '/candidate/unrelated',
      lifecycle: ADMIN,
    }), { kind: 'stack-script', protectedProfile: false });
  });

  it('refuses the selected managed uploader when no installed target binds it', async () => {
    const { runner } = await installed({
      viewer: {
        profile: 'viewer-a',
        portSlot: 2,
        target: 'local',
        services: ['client'],
      },
    });

    await assert.rejects(runner.route({
      profile: 'managed',
      portSlot: 4,
      uploaderId: 'srs-uploader-a',
      services: ['srs', 'stream-uploader'],
      candidateRoot: '/candidate/managed',
      lifecycle: ADMIN,
    }), /not installed/);
  });
});
