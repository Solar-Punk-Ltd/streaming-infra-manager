import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'target-attempt-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');

function setup(expectedId?: string) {
  const profiles = [
    makeProfile({ name: 'remote', host: 'edge', components: ['srs'] }),
    makeProfile({ name: 'alias', host: 'admin@edge', port_slot: 2, components: ['srs'] }),
    makeProfile({ name: 'local', host: 'localhost', port_slot: 3, components: ['srs'] }),
  ];
  const h = orchestratorHarness(profiles, undefined, undefined,
    expectedId ? { daemonIdFor: async () => expectedId } : undefined);
  h.daemon.autoRecreate = false;
  let remoteId = 'remote-daemon';
  let remoteContainer = 'remote-old';
  h.daemon.daemonId = async (target = 'localhost') => target === 'localhost' ? 'local-daemon' : remoteId;
  h.daemon.containerIdsOf = async (_project, target = 'localhost') =>
    new Map([['srs', [target === 'localhost' ? 'local-new' : remoteContainer]]]);
  return {
    ...h,
    row: (name: string) => h.profiles.rows.get(name)!,
    move: () => { remoteId = 'different-daemon'; },
    recreate: () => { remoteContainer = 'remote-new'; },
  };
}

describe('deploy attempts on their target daemon', () => {
  it('requires inventory for deploy admission but never for Stop or Remove identity checks', async () => {
    const stored = [makeProfile({ name: 'incomplete', status: 'RUNNING', components: ['srs'] })];
    let scans = 0;
    const h = orchestratorHarness(stored, undefined, undefined,
      { daemonIdFor: async () => 'daemon-1' },
      { daemonIdFor: async () => { scans += 1; throw new Error('inventory cannot parse the old contract'); } });
    await assert.rejects(h.orchestrator.startDeploy(h.profiles.rows.get('incomplete')!, ['srs']), /inventory cannot parse/);
    assert.equal(scans, 1);
    assert.equal(h.runner.runs.length, 0);
    await h.orchestrator.startStop(h.profiles.rows.get('incomplete')!, undefined);
    assert.equal(scans, 1);
    assert.equal(h.runner.runs.length, 1);
    h.profiles.write('incomplete', { status: 'STOPPED' });
    await h.orchestrator.startRemove(h.profiles.rows.get('incomplete')!);
    assert.equal(scans, 1);
    assert.equal(h.runner.runs.length, 2);
  });

  it('refuses admission when the container snapshot came from a different daemon than the preflight', async () => {
    const h = setup('remote-daemon');
    const older = await h.ledger.describe('remote', await h.versions.findById(1), ['srs', 'stream-uploader']);
    h.daemon.snapshot = async () => ({
      daemonId: 'different-daemon',
      containers: new Map([['srs', ['other-new']]]),
    });
    await assert.rejects(h.orchestrator.startDeploy(h.row('remote'), ['srs']), /different Docker daemon/);
    assert.equal(h.runner.runs.length, 0);
    assert.equal(h.attempts.rows.length, 0);
    assert.deepEqual(h.ledger.openJobReferences('remote').map(reference => reference.id), [older.referenceId]);
  });

  it('retains the job reference if runner invocation throws with an uncertain launch outcome', async () => {
    const h = setup('remote-daemon');
    h.runner.run = () => { throw new Error('unknown runner outcome'); };
    await assert.rejects(h.orchestrator.startDeploy(h.row('remote'), ['srs']), /unknown runner outcome/);
    assert.equal(h.ledger.openJobReferences('remote').length, 1);
    assert.equal(h.attempts.rows.length, 1);
  });

  it('keeps recovery held when a different daemon supplies the container snapshot after preflight', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    h.recreate();
    h.daemon.snapshot = async () => ({
      daemonId: 'different-daemon',
      containers: new Map([['srs', ['other-new']]]),
    });
    await h.orchestrator.reconcileAttempts();
    assert.equal(h.attempts.rows[0]!.state, 'open');
  });
  for (const action of ['stop', 'remove'] as const) {
    it(`refuses ${action} before a claim or script when the alias has moved to another daemon`, async () => {
      const h = setup('remote-daemon');
      h.move();
      await assert.rejects(
        action === 'stop'
          ? h.orchestrator.startStop(h.row('remote'), undefined)
          : h.orchestrator.startRemove(h.row('remote')),
        /different Docker daemon/,
      );
      assert.equal(h.runner.runs.length, 0);
      assert.equal(h.profiles.statusOf('remote'), 'RUNNING');
    });
  }
  it('persists the alias, remote identity and remote pre-job container set', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    const attempt = h.attempts.rows[0]!;
    assert.equal(attempt.target, 'edge');
    assert.equal(attempt.daemonId, 'remote-daemon');
    assert.deepEqual(attempt.preJobContainerIds, ['remote-old']);
  });

  it('shares a guard between aliases while allowing an unrelated local daemon', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    await assert.rejects(h.orchestrator.startDeploy(h.row('alias'), ['srs']), /remote/);
    await h.orchestrator.startDeploy(h.row('local'), ['srs']);
    assert.deepEqual(h.attempts.rows.map((row) => row.daemonId), ['remote-daemon', 'local-daemon']);
  });

  it('judges completion using the same remote target, never the local project', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    h.recreate();
    h.runner.finish(0);
    await untilRunning(h.profiles, 'remote');
    assert.equal(h.attempts.rows[0]!.state, 'released');
  });

  it('finds remote attempts at boot and judges them on their recorded target', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    h.recreate();
    assert.equal((await h.orchestrator.unresolvedAttempts()).length, 1);
    const result = await h.orchestrator.reconcileAttempts();
    assert.deepEqual(result.released, ['remote']);
  });

  it('keeps the attempt held if its alias now reaches a different daemon', async () => {
    const h = setup();
    await h.orchestrator.startDeploy(h.row('remote'), ['srs']);
    h.recreate();
    h.move();
    await h.orchestrator.reconcileAttempts();
    assert.equal(h.attempts.rows[0]!.state, 'open');
  });
});
