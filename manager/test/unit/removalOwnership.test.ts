import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 't10-removal-ownership-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
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

function setup() {
  const original = makeProfile({ name: 'owned', instance_id: randomUUID(), status: 'RUNNING', components: ['srs'] });
  const h = orchestratorHarness([original]);
  return { ...h, original };
}
async function drain() {
  for (let tick = 0; tick < 10; tick++) await new Promise(resolve => setImmediate(resolve));
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
    h.runner.finish(0, outcome === 'success' ? 0 : 1);
    await drain();
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
