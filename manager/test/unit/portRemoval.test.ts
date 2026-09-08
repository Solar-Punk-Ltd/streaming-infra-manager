import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'port-removal-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

async function setup() {
  const h = orchestratorHarness([makeProfile({ name: 'a', components: ['srs'], status: 'ERROR' })]);
  await h.profiles.reservations.plan('daemon-1', 'a', [{ protocol: 'tcp', port: 10012, service: 'srs', portVar: 'RTMP_PORT' }], 'original');
  return { ...h, row: () => h.profiles.rows.get('a')! };
}

describe('verified port release on removal', () => {
  it('refuses removal before cleanup while an orphaned attempt can still create containers', async () => {
    const h = await setup();
    await h.attempts.open({ daemonId: 'daemon-1', project: 'a', target: 'localhost', jobId: 'orphan', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
    await assert.rejects(h.orchestrator.startRemove(h.row()), /orphan|attempt/);
    assert.equal(h.runner.runs.length, 0);
    assert.equal(h.attempts.rows[0]!.state, 'open');
  });

  for (const evidence of ['container remains', 'port remains', 'wrong daemon', 'host network', 'another reservation daemon'] as const) {
    it(`retains the profile and ports when cleanup succeeds but ${evidence}`, async () => {
      const h = await setup();
      if (evidence === 'another reservation daemon') {
        await h.profiles.reservations.plan('other', 'a', [{ protocol: 'tcp', port: 10012, service: 'srs', portVar: 'RTMP_PORT' }], 'unreconciled');
      }
      await h.orchestrator.startRemove(h.row());
      if (evidence !== 'container remains') h.daemon.containers.delete('a');
      if (evidence === 'port remains') h.published.bindings = [{ project: 'outside', service: 'web', protocol: 'tcp', port: 10012 }];
      if (evidence === 'wrong daemon') h.published.daemonId = 'other';
      if (evidence === 'host network') h.published.unverifiedProjects = ['unknown'];
      const finished = new Promise<void>(resolve => h.events.subscribe(event => {
        if (event.type === 'profile.deleted' || (event.type === 'profile.changed' && event.profile.status === 'ERROR')) resolve();
      }));
      h.runner.finish(0);
      await finished;
      assert.equal(h.row()?.status, 'ERROR');
      assert.ok((await h.profiles.reservations.listByProfile('a')).length);
    });
  }

  it('frees the profile and all its reservations only after cleanup and observed absence', async () => {
    const h = await setup();
    await h.orchestrator.startRemove(h.row());
    h.daemon.containers.delete('a');
    const finished = new Promise<void>(resolve => h.events.subscribe(event => { if (event.type === 'profile.deleted') resolve(); }));
    h.runner.finish(0);
    await finished;
    assert.equal(h.row(), undefined);
    assert.deepEqual(await h.profiles.reservations.listByProfile('a'), []);
  });
});
