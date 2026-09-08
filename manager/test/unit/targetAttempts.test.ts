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

function setup() {
  const profiles = [
    makeProfile({ name: 'remote', host: 'edge', components: ['srs'] }),
    makeProfile({ name: 'alias', host: 'admin@edge', port_slot: 2, components: ['srs'] }),
    makeProfile({ name: 'local', host: 'localhost', port_slot: 3, components: ['srs'] }),
  ];
  const h = orchestratorHarness(profiles);
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
