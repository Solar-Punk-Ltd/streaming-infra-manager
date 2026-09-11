import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';
import { throwawayRoot } from '../support/throwawayRoot.js';
import type { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';

const root = throwawayRoot('t10-removal-ownership-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
process.env.DATABASE_URL = 'postgres://unused';
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
  writeFileSync(join(root, '.env.example'), 'ENGINE=srs\n');
  mkdirSync(join(root, 'data', 'owned'), { recursive: true });
  writeFileSync(join(root, 'data', 'owned', 'sentinel'), 'owned data');
  writeFileSync(join(root, '.env.owned'), 'owned env');
});

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { ProfileService } = await import('../../src/domain/ProfileService.js');
const { createProfilesRouter } = await import('../../src/api/routes/profiles.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

function setup() {
  const original = makeProfile({ name: 'owned', instance_id: randomUUID(), status: 'RUNNING', components: ['srs'] });
  const h = orchestratorHarness([original]);
  return { ...h, original };
}

it('refuses a replaced instance before preparing files or launching cleanup', async () => {
  const h = setup();
  const replacement = { ...h.original, instance_id: randomUUID() };
  h.profiles.rows.set('owned', replacement);
  rmSync(join(root, '.env'));
  await assert.rejects(h.orchestrator.startRemove(h.original), /instance|changed|replaced/i);
  assert.equal(existsSync(join(root, '.env')), false, 'bootstrap is write-capable and requires ownership');
  assert.equal(h.runner.runs.length, 0);
  assert.deepEqual(h.profiles.rows.get('owned'), replacement);
});

it('uses the current claimed port slot instead of a pre-claim profile copy', async () => {
  const h = setup();
  h.profiles.write('owned', { port_slot: 7 });
  await h.orchestrator.startRemove(h.original);
  assert.ok(h.runner.runs[0]!.args.includes('--portSlot=7'));
  assert.equal(h.profiles.rows.get('owned')!.intent_revision, h.original.intent_revision + 1);
});

for (const outcome of ['failure', 'success'] as const) {
  it(`a late cleanup ${outcome} cannot change a replacement instance or its files`, async () => {
    const h = setup();
    await h.orchestrator.startRemove(h.original);
    const replacement = { ...h.original, instance_id: randomUUID(), status: 'REMOVING' as const };
    h.profiles.rows.set('owned', replacement);
    h.daemon.containers.delete('owned');
    writeFileSync(join(root, 'data', 'owned', 'sentinel'), 'replacement data');
    writeFileSync(join(root, '.env.owned'), 'replacement env');
    let finalized!: () => void;
    const completion = new Promise<void>(resolve => { finalized = resolve; });
    const success = h.profiles.completeRemoval.bind(h.profiles);
    const failure = h.profiles.failRemoval.bind(h.profiles);
    h.profiles.completeRemoval = async (...args) => { try { return await success(...args); } finally { finalized(); } };
    h.profiles.failRemoval = async (...args) => { try { return await failure(...args); } finally { finalized(); } };
    h.runner.finish(0, outcome === 'success' ? 0 : 1);
    await completion;
    assert.deepEqual(h.profiles.rows.get('owned'), replacement);
    assert.equal(readFileSync(join(root, 'data', 'owned', 'sentinel'), 'utf8'), 'replacement data');
    assert.equal(readFileSync(join(root, '.env.owned'), 'utf8'), 'replacement env');
  });
}

it('removes all name-owned files before releasing the profile name', async () => {
  const h = setup();
  let filesAtRelease: boolean | undefined;
  const remove = h.profiles.deleteByName.bind(h.profiles);
  h.profiles.deleteByName = async name => {
    filesAtRelease = existsSync(join(root, '.env.owned')) || existsSync(join(root, 'data', name));
    return remove(name);
  };
  await h.orchestrator.startRemove(h.original);
  h.daemon.containers.delete('owned');
  const deleted = new Promise<void>(resolve => {
    const unsubscribe = h.events.subscribe(event => {
      if (event.type === 'profile.deleted') { unsubscribe(); resolve(); }
    });
  });
  h.runner.finish(0);
  await deleted;
  assert.equal(filesAtRelease, false);
});

for (const explicit of [false, true]) {
  it(`refuses replacement between the real service read and claim with ${explicit ? 'explicit' : 'omitted'} client identity`, async () => {
    const h = setup();
    const service = new ProfileService(h.profiles.asRepository(), h.containers.asRepository(), h.orchestrator,
      h.events, {} as DeploymentGroupRepository, h.versions);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const readStarted = new Promise<void>(resolve => { entered = resolve; });
    const withContainers = h.containers.withContainers.bind(h.containers);
    h.containers.withContainers = async profile => { entered(); await held; return withContainers(profile); };
    const app = await startRouterTestApp(createProfilesRouter(service), '/profiles');
    const pending = call(app, 'DELETE', '/profiles/owned', explicit ? { expectedInstanceId: h.original.instance_id } : undefined);
    let replacement = h.original;
    try {
      await readStarted;
      replacement = { ...h.original, instance_id: randomUUID() };
      h.profiles.rows.set('owned', replacement);
    } finally { release(); }
    try {
      const response = await pending;
      assert.equal(response.status, 409);
      assert.equal((response.body as { error: string }).error, 'profile_instance_changed');
      assert.equal(h.runner.runs.length, 0);
      assert.deepEqual(h.profiles.rows.get('owned'), replacement);
      assert.equal(readFileSync(join(root, 'data', 'owned', 'sentinel'), 'utf8'), 'owned data');
    } finally { await app.close(); }
  });
}

it('a refused preparation records failure only on the instance which claimed removal', async () => {
  const h = setup();
  const originalVersionLookup = h.versions.findById.bind(h.versions);
  let replacement = h.original;
  h.versions.findById = async id => {
    replacement = { ...h.original, instance_id: randomUUID() };
    h.profiles.rows.set('owned', replacement);
    throw new Error('synthetic path lookup failure');
  };
  try { await assert.rejects(h.orchestrator.startRemove(h.original), /synthetic path lookup failure/); }
  finally { h.versions.findById = originalVersionLookup; }
  assert.deepEqual(h.profiles.rows.get('owned'), replacement);
  assert.equal(h.runner.runs.length, 0);
});
