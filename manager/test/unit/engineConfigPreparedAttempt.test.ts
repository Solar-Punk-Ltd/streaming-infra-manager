import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 't01-prepared-attempt-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'), 'listen 1935;\n');
writeFileSync(join(root, 'engines', 'srs', 'entrypoint.sh'), '');
after(() => rmSync(root, { recursive: true, force: true }));
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

async function prepared() {
  const h = orchestratorHarness([makeProfile({ name: 'prepared-owner' })]);
  const reservation = await h.orchestrator.reserveDeploy(h.profiles.rows.get('prepared-owner')!, ['srs']);
  const before = await h.daemon.snapshot('prepared-owner', 'localhost');
  const attempt = await h.attempts.open({ daemonId: h.daemon.id, target: 'localhost', project: 'prepared-owner',
    jobId: 'synthetic-config-attempt', kind: 'shared', services: ['srs'], preJobContainerIds: [...before.containers.values()].flat() });
  return { h, reservation: { ...reservation, attempt: structuredClone(attempt) } };
}

it('consumes the exact admitted config attempt without recapturing or opening another guard', async () => {
  const { h, reservation } = await prepared();
  let snapshots = 0;
  const originalSnapshot = h.daemon.snapshot.bind(h.daemon);
  h.daemon.snapshot = async (...args) => { snapshots++; return originalSnapshot(...args); };
  await h.orchestrator.runReserved(reservation, reservation.claimedProfile!);
  assert.equal(h.runner.runs.length, 1);
  assert.equal(h.attempts.rows.length, 1);
  assert.equal(h.attempts.rows[0]!.id, reservation.attempt.id);
  assert.equal(h.attempts.rows[0]!.state, 'open');
  assert.equal(snapshots, 0, 'the admitted pre-job set is consumed unchanged');
  assert.equal(h.profiles.activeDeployJobs.get('prepared-owner'), reservation.build!.referenceId);
});

for (const changed of ['target', 'services', 'released'] as const) {
  it(`refuses an admitted attempt whose ${changed} no longer matches before starting a script`, async () => {
    const { h, reservation } = await prepared();
    if (changed === 'target') reservation.attempt.target = 'different-target';
    else if (changed === 'services') reservation.attempt.services = ['bee-node'];
    else await h.attempts.release(reservation.attempt.id, 'synthetic operator');
    await assert.rejects(h.orchestrator.runReserved(reservation, reservation.claimedProfile!));
    assert.equal(h.runner.runs.length, 0);
    assert.equal(h.attempts.rows.length, 1);
    assert.equal(h.attempts.rows[0]!.state, changed === 'released' ? 'released' : 'open');
    assert.equal(h.profiles.statusOf('prepared-owner'), 'ERROR');
    assert.equal(h.profiles.activeDeployJobs.get('prepared-owner'), reservation.build!.referenceId);
    assert.equal(h.ledger.references.find(row => row.id === reservation.build!.referenceId)!.resolvedAt, null);
  });
}

it('ordinary deploy rejects a snapshot that spans another same-project attempt opening and resolving', async () => {
  const h = orchestratorHarness([makeProfile({ name: 'ordinary-owner' })]);
  const reservation = await h.orchestrator.reserveDeploy(h.profiles.rows.get('ordinary-owner')!, ['srs']);
  const snapshot = h.daemon.snapshot.bind(h.daemon);
  h.daemon.snapshot = async (...args) => {
    const captured = await snapshot(...args);
    const intervening = await h.attempts.open({ daemonId: h.daemon.id, target: 'localhost', project: 'ordinary-owner',
      jobId: 'synthetic-intervening', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
    await h.attempts.resolve(intervening.id, { state: 'released', reason: null });
    return captured;
  };
  await assert.rejects(h.orchestrator.runReserved(reservation, reservation.claimedProfile!), /history|snapshot|attempt/i);
  assert.equal(h.runner.runs.length, 0);
  assert.equal(h.attempts.rows.length, 1);
  assert.equal(h.attempts.rows[0]!.jobId, 'synthetic-intervening');
});
