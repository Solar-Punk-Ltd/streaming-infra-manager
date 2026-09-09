import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { rolloutNotice } from '@streaming-infra-manager/common';
import type { EngineWatcher } from '../../src/domain/engineConfig/EngineConfigService.js';

const root = mkdtempSync(join(tmpdir(), 't01-creation-guard-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'), 'listen 1935;\n');
writeFileSync(join(root, 'engines', 'srs', 'entrypoint.sh'), '');
after(() => rmSync(root, { recursive: true, force: true }));

const { EngineConfigService } = await import('../../src/domain/engineConfig/EngineConfigService.js');
const { EngineConfigChecker } = await import('../../src/domain/engineConfig/engineConfigCheck.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { ALLOCATION_CONTRACT } = await import('../support/allocationContract.js');
const OLD = 'listen 1935; # previous\n';
const A = 'listen 1935; # new\n';

async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300; tick++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The owned rollout did not finish handling its script failure');
}

async function setup() {
  const h = orchestratorHarness([makeProfile({ name: 'stage', has_engine_config: true })]);
  await h.versions.setContract(1, { ...ALLOCATION_CONTRACT, engineConfig: { srs: true, ome: false }, engineImages: { srs: 'ossrs/srs:6', ome: null } });
  h.profiles.engineConfigs.set('stage', OLD);
  h.daemon.autoRecreate = false;
  const watcher: EngineWatcher = { inspect: async () => null, logs: async () => '', reachable: async () => false };
  const service = new EngineConfigService(h.profiles.asRepository(), h.containers.asRepository(), h.orchestrator,
    h.versions, watcher, new EngineConfigChecker(async () => ({ code: 0, stdout: '', stderr: '' })), h.events, h.operations,
    { intervalMs: 5, durationMs: 25, probeBudgetMs: 5 });
  return { h, service, watcher, row: () => h.profiles.rows.get('stage')! };
}

it('keeps a failed config rollout interrupted when unchanged containers still hold its creation guard', async () => {
  const { h, service, row } = await setup();
  await service.apply('stage', A);
  assert.equal(h.runner.runs.length, 1);
  h.runner.finish(0, 17);
  await until(() => h.operations.rows[0]?.state !== 'applying');
  const operation = h.operations.rows[0]!;
  assert.equal(h.attempts.rows[0]?.state, 'blocked');
  assert.equal(operation.state, 'interrupted');
  assert.equal((await h.operations.findOpen(row().instance_id))?.id, operation.id);
  assert.equal(operation.previousConfig, OLD);
  assert.equal(operation.previousIsTemplate, false);
  assert.equal(h.profiles.engineConfigs.get('stage'), A, 'A claim refusal cannot restore the previous file');
  assert.equal(row().status, 'ERROR');
  assert.equal(row().engine_config_state, 'interrupted');
  assert.match(operation.message ?? '', /exited with code 17/);
  assert.match(operation.message ?? '', /claim/);
  assert.doesNotMatch(operation.message ?? '', /previous one is back/);
  assert.equal(row().engine_config_error, operation.message);
  assert.match(row().last_error ?? '', /exited with code 17/);
  assert.ok(rolloutNotice(row().engine_config_state, { engine: 'SRS', hasConfig: true }, null)?.offers.includes('previous'));
  await service.reconcileAtBoot();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(h.runner.runs.length, 1, 'Neither failure handling nor reconciliation retries the script');
  await assert.rejects(service.recreateOnPrevious('stage'), /blocked|attempt|unfinished/i);
  assert.equal(h.profiles.engineConfigs.get('stage'), A);
  assert.equal(operation.state, 'interrupted');
  assert.equal(h.runner.runs.length, 1);
});

it('does not relabel or rewrite a rollout whose ownership changes before the refused rollback claim', async () => {
  const { h, service, row, watcher } = await setup();
  let afterOperator: unknown;
  let hookFinished = false;
  watcher.logs = async () => {
    await h.profiles.bumpIntent('stage');
    await h.operations.supersedeOpen(row().instance_id, 'Stopped by the operator');
    h.profiles.write('stage', { status: 'STOPPED' });
    afterOperator = structuredClone(row());
    hookFinished = true;
    return '';
  };
  await service.apply('stage', A);
  h.runner.finish(0, 17);
  await until(() => hookFinished);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(row(), afterOperator);
  assert.equal(h.operations.rows[0]?.state, 'superseded');
  assert.equal(h.operations.rows[0]?.message, 'Stopped by the operator');
  assert.equal(h.profiles.engineConfigs.get('stage'), A);
  assert.equal(h.runner.runs.length, 1);
  assert.equal(h.attempts.rows[0]?.state, 'blocked');
});
