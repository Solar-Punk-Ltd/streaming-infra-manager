import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import type { DeployReservation } from '../../src/domain/DeploymentOrchestrator.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile } from '../../src/types/index.js';

const root = mkdtempSync(join(tmpdir(), 't11-version-defaults-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/t11_unused';
after(() => rmSync(root, { recursive: true, force: true }));

const { ProfileService } = await import('../../src/domain/ProfileService.js');
const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { ALLOCATION_CONTRACT } = await import('../support/allocationContract.js');

const instanceId = '11111111-1111-4111-8111-111111111111';
const publishers = ['1080p', '720p', '480p', '360p']
  .map((rung, index) => `${rung}@http://192.0.2.10:${12015 + index * 10}<${'a'.repeat(64)}>`).join(' ');
const initial = () => makeProfile({ name: 'observed', instance_id: instanceId, kind: 'custom',
  components: ['srs', 'stream-uploader'], stamp_id: 'a'.repeat(64), bee_publishers: publishers });

function build(base: StackVersionRecord, parent: string, id: string, fps: string, fragment: string): StackVersionRecord {
  const dir = join(parent, 'bundled.builds', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), `ENGINE=srs\nABR_FPS=${fps}\n`);
  writeFileSync(join(dir, '.stack-manifest.json'), JSON.stringify({ buildId: id, commit: id,
    builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic fixture' }));
  writeFileSync(join(dir, '.complete'), '');
  return { ...structuredClone(base), rootPath: join(parent, 'bundled'), layout: 'builds', buildId: id,
    commitSha: id, contract: { ...structuredClone(ALLOCATION_CONTRACT), engineDefaults: { HLS_FRAGMENT: fragment } } };
}

async function setup(fragments: [string, string]) {
  const parent = mkdtempSync(join(root, 'case-'));
  const h = orchestratorHarness([initial()], undefined, parent);
  const stored = (await h.versions.findById(1))!;
  const a = build(stored, parent, 'aaaaaaa', '30', fragments[0]);
  const b = build(stored, parent, 'bbbbbbb', '25', fragments[1]);
  Object.assign(stored, structuredClone(a));
  const service = new ProfileService(h.profiles.asRepository(), h.containers.asRepository(), h.orchestrator,
    h.events, {} as DeploymentGroupRepository, h.versions);
  const app = await startEngineTestApp(service, new ContainerControl(h.events, fakeDocker([])));
  return { ...h, service, app, a, b, stored };
}

function hold() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  return { arrive, release, resume, arrived };
}

describe('engine settings capture one version for defaults and admission', { timeout: 15000 }, () => {
  it('does not falsely refuse two valid versions by mixing A host defaults with B contract defaults', async () => {
    const h = await setup(['0.5', '0.52']);
    let reads = 0;
    h.versions.findById = async () => structuredClone(++reads === 1 ? h.a : h.b);
    try {
      const result = await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { ABR_PRESET: 'fast', expectedInstanceId: instanceId });
      assert.equal(result.status, 202);
      assert.equal(reads, 1, 'validation and admission must not select independent version records');
      assert.equal(h.runner.runs.length, 1);
      assert.ok(h.runner.runs[0]!.script.includes('/aaaaaaa/'));
    } finally { await h.app.close(); }
  });

  it('does not falsely accept two invalid versions by combining A host defaults with B contract defaults', async () => {
    const h = await setup(['0.52', '0.5']);
    const before = structuredClone(h.profiles.rows.get('observed'));
    let reads = 0;
    h.versions.findById = async () => structuredClone(++reads === 1 ? h.a : h.b);
    try {
      const result = await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { ABR_PRESET: 'fast', expectedInstanceId: instanceId });
      assert.equal(result.status, 400);
      assert.deepEqual(h.profiles.rows.get('observed'), before);
      assert.deepEqual(h.ledger.references, []);
      assert.deepEqual(h.runner.runs, []);
      assert.equal(reads, 1);
    } finally { await h.app.close(); }
  });

  for (const selected of ['a', 'b'] as const) {
    it(`accepts the complete legal ${selected.toUpperCase()} pair`, async () => {
      const h = await setup(['0.5', '0.52']);
      Object.assign(h.stored, structuredClone(h[selected]));
      try {
        const result = await callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { ABR_PRESET: 'fast', expectedInstanceId: instanceId });
        assert.equal(result.status, 202);
        assert.equal(h.runner.runs.length, 1);
        assert.deepEqual(h.profiles.rows.get('observed')!.engine_settings, { ABR_PRESET: 'fast' });
      } finally { await h.app.close(); }
    });
  }

  it('copies the service version before a later admission wait can mutate its returned object', async () => {
    const h = await setup(['0.5', '0.52']);
    const returned = structuredClone(h.a);
    h.versions.findById = async () => returned;
    const gate = hold();
    const reserve = h.orchestrator.reserveDeploy.bind(h.orchestrator);
    h.orchestrator.reserveDeploy = async (...args) => { gate.arrive(); await gate.resume; return reserve(...args); };
    const pending = callEngine(h.app, 'PUT', '/profiles/observed/engine-settings', { ABR_PRESET: 'fast', expectedInstanceId: instanceId });
    try {
      await gate.arrived;
      Object.assign(returned, structuredClone(h.b));
      gate.release();
      assert.equal((await pending).status, 202);
      assert.ok(h.runner.runs[0]!.script.includes('/aaaaaaa/'));
    } finally { gate.release(); await pending; await h.app.close(); }
  });

  it('copies an explicitly supplied capture before asynchronous admission checks and never reselects', async () => {
    const h = await setup(['0.5', '0.52']);
    const gate = hold();
    h.daemon.daemonId = async () => { gate.arrive(); await gate.resume; return h.daemon.id; };
    let reads = 0;
    h.versions.findById = async () => { reads += 1; return structuredClone(h.b); };
    const selected = structuredClone(h.a);
    const reserve = h.orchestrator.reserveDeploy.bind(h.orchestrator) as
      (profile: Profile, services: string[], captured: StackVersionRecord) => Promise<DeployReservation>;
    const pending = reserve(initial(), ['srs'], selected);
    pending.catch(() => {});
    try {
      await gate.arrived;
      Object.assign(selected, structuredClone(h.b));
      gate.release();
      const result = await pending;
      assert.equal(reads, 0, 'a supplied capture must not be reselected');
      assert.equal(result.build?.version?.buildId, h.a.buildId);
      assert.equal(result.build?.version?.contract?.engineDefaults.HLS_FRAGMENT, '0.5');
      await h.orchestrator.cancelReservation(result);
    } finally { gate.release(); await pending.catch(() => {}); await h.app.close(); }
  });
});
