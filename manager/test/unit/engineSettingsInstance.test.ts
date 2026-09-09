import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import type { ManagerEvent } from '../../src/domain/EventBus.js';
import type { Profile } from '../../src/types/index.js';

const root = mkdtempSync(join(tmpdir(), 't11-settings-instance-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/t11_unused';
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));

const { ProfileService } = await import('../../src/domain/ProfileService.js');
const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const originalId = '11111111-1111-4111-8111-111111111111';
const replacementId = '22222222-2222-4222-8222-222222222222';
const initial = () => makeProfile({ name: 'observed', instance_id: originalId, stamp_id: 'a'.repeat(64) });

async function setup() {
  const harness = orchestratorHarness([initial()]);
  const service = new ProfileService(harness.profiles.asRepository(), harness.containers.asRepository(),
    harness.orchestrator, harness.events, {} as DeploymentGroupRepository, harness.versions);
  const app = await startEngineTestApp(service, new ContainerControl(harness.events, fakeDocker([])));
  const events: ManagerEvent[] = [];
  harness.events.subscribe(event => events.push(event));
  return { ...harness, service, app, events,
    replace() {
      const replacement = makeProfile({ ...initial(), instance_id: replacementId, engine_settings: { HLS_FRAGMENT: '6' }, intent_revision: 40 });
      harness.profiles.rows.set('observed', replacement);
      return replacement;
    },
  };
}

function hold() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  return { arrive, release, resume, wait: () => Promise.race([arrived,
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Held request did not arrive')), 2000); timer.unref(); })]) };
}

function changed(result: { status: number; body: unknown }) {
  assert.equal(result.status, 409);
  assert.equal((result.body as { error: string }).error, 'profile_instance_changed');
}

describe('engine settings saves are bound to the observed instance', { timeout: 15000 }, () => {
  it('refuses an old drawer before defaults, writes or deployment claims', async () => {
    const h = await setup();
    const replacement = h.replace();
    let versionReads = 0;
    const find = h.versions.findById.bind(h.versions);
    h.versions.findById = async id => { versionReads += 1; return find(id); };
    try {
      changed(await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId }));
      assert.equal(versionReads, 0);
      assert.deepEqual(h.profiles.rows.get('observed'), replacement);
      assert.deepEqual(h.events, []);
      assert.deepEqual(h.runner.runs, []);
    } finally { await h.app.close(); }
  });

  for (const explicit of [true, false]) {
    it(`refuses replacement after defaults began, with ${explicit ? 'explicit' : 'legacy captured'} identity`, async () => {
      const h = await setup(); const gate = hold();
      const find = h.versions.findById.bind(h.versions);
      h.versions.findById = async id => { const captured = await find(id); gate.arrive(); await gate.resume; return captured; };
      const pending = callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', {
        HLS_FRAGMENT: '2', ...(explicit ? { expectedInstanceId: originalId } : {}),
      });
      try {
        await gate.wait(); const replacement = h.replace(); gate.release();
        changed(await pending);
        assert.deepEqual(h.profiles.rows.get('observed'), replacement);
        assert.deepEqual(h.events, []);
        assert.deepEqual(h.runner.runs, []);
      } finally { gate.release(); await pending; await h.app.close(); }
    });
  }

  it('does not write settings or restore the old status on a replacement after claiming', async () => {
    const h = await setup(); const gate = hold();
    const write = h.profiles.updateEngineSettings.bind(h.profiles);
    h.profiles.updateEngineSettings = async (...args) => { gate.arrive(); await gate.resume; return write(...args); };
    const pending = callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId });
    try {
      await gate.wait(); const replacement = h.replace(); gate.release();
      changed(await pending);
      assert.deepEqual(h.profiles.rows.get('observed'), replacement);
      assert.deepEqual(h.runner.runs, []);
      assert.equal(h.events.filter(event => event.type === 'profile.changed' && event.profile.instance_id === replacementId).length, 0);
    } finally { gate.release(); await pending; await h.app.close(); }
  });

  it('cannot bump the replacement intent when the operator action resumes after a claim', async () => {
    const h = await setup(); const gate = hold();
    const claim = h.ledger.claim.bind(h.ledger);
    h.ledger.claim = async (...args) => {
      const claimed = await claim(...args);
      gate.arrive(); await gate.resume;
      return claimed;
    };
    const pending = callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId });
    try {
      await gate.wait(); const replacement = h.replace(); gate.release();
      changed(await pending);
      assert.deepEqual(h.profiles.rows.get('observed'), replacement);
      assert.deepEqual(h.runner.runs, []);
    } finally { gate.release(); await pending; await h.app.close(); }
  });

  it('retains the winning claim identity when a later row replaces the name', async () => {
    const h = await setup();
    try {
      const reservation = await h.orchestrator.reserveDeploy(initial(), ['srs']);
      const claim = (reservation as typeof reservation & { claimedProfile?: Profile }).claimedProfile;
      assert.equal(claim?.instance_id, originalId);
      assert.equal(claim?.intent_revision, 1);
      const replacement = h.replace();
      await h.orchestrator.cancelReservation(reservation);
      assert.deepEqual(h.profiles.rows.get('observed'), replacement);
    } finally { await h.app.close(); }
  });

  for (const expectedInstanceId of [null, 'not-a-uuid', 12]) {
    it(`rejects invalid expected identity ${JSON.stringify(expectedInstanceId)}`, async () => {
      const h = await setup();
      try {
        assert.equal((await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId })).status, 400);
        assert.deepEqual(h.profiles.rows.get('observed'), initial());
        assert.deepEqual(h.events, []);
        assert.deepEqual(h.runner.runs, []);
      } finally { await h.app.close(); }
    });
  }

  it('keeps missing and busy states distinct from a changed instance', async () => {
    const h = await setup();
    try {
      h.profiles.rows.delete('observed');
      assert.equal((await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId })).status, 404);
      h.profiles.rows.set('observed', { ...initial(), status: 'DEPLOYING' });
      const busy = await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId });
      assert.equal(busy.status, 409);
      assert.equal((busy.body as { error: string }).error, 'profile_busy');
    } finally { await h.app.close(); }
  });

  it('accepts the current instance without storing the guard as a setting', async () => {
    const h = await setup();
    try {
      const result = await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { HLS_FRAGMENT: '2', expectedInstanceId: originalId });
      assert.equal(result.status, 202);
      assert.equal((result.body as Profile).instance_id, originalId);
      assert.deepEqual(h.profiles.rows.get('observed')?.engine_settings, { HLS_FRAGMENT: '2' });
      assert.equal(h.profiles.rows.get('observed')?.intent_revision, 1);
      assert.equal(h.runner.runs.length, 1);
    } finally { await h.app.close(); }
  });
});
