/**
 * What the manager can and cannot say about an OvenMediaEngine file once the
 * engine stayed up on it.
 *
 * Unit test, no database, no Docker and no deploy script. `pnpm test` in
 * manager/. The watch runs at millisecond timings.
 *
 * OvenMediaEngine has no parser to ask before the recreate, so once the
 * watch is over the manager tries the HLS port the deployment publishes on.
 * A port that answers is liveness, not a verdict on the file, and a port that
 * does not answer is a diagnosis the card shows next to an applied rollout,
 * never a reason to put the previous file back.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  OME_SERVICE,
  type StackContract,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import type { ContainerState } from '../../src/domain/ContainerControl.js';
import type { EngineWatcher } from '../../src/domain/engineConfig/EngineConfigService.js';
import { omePortsFor, portTableOf } from '../../src/domain/versions/portTable.js';
import { OME_TEMPLATE } from '../support/omeTemplate.js';

const root = mkdtempSync(join(tmpdir(), 'ome-liveness-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'engines', 'ome'), { recursive: true });
writeFileSync(join(root, 'engines', 'ome', 'Server.xml.template'), OME_TEMPLATE);
writeFileSync(
  join(root, 'engines', 'ome', 'entrypoint.sh'),
  'sed -i "s/OME_ADAPTER_HOST_PLACEHOLDER/x/; s/OME_ADAPTER_PORT_PLACEHOLDER/x/; s/OME_ADMISSION_SECRET_PLACEHOLDER/x/; s/SEGMENT_DURATION_PLACEHOLDER/x/; s/SEGMENT_COUNT_PLACEHOLDER/x/"\n',
);
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'), 'listen 1935;\n');
writeFileSync(join(root, 'engines', 'srs', 'entrypoint.sh'), '');

const { EngineConfigChecker } = await import(
  '../../src/domain/engineConfig/engineConfigCheck.js'
);
const { EngineConfigService } = await import(
  '../../src/domain/engineConfig/EngineConfigService.js'
);
const { profileRow, profileServiceHarness } = await import(
  '../support/profileServiceHarness.js'
);
const { InMemoryEngineConfigOperations } = await import(
  '../support/InMemoryEngineConfigOperations.js'
);

const V3_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
};

const RUNNING: ContainerState = {
  id: 'c1',
  status: 'running',
  restartCount: 0,
  startedAt: '2026-09-08T10:00:00Z',
};

const OME_SLOT = 2;
const HLS_PORT = omePortsFor(OME_SLOT, portTableOf(V3_CONTRACT)).omeHlsPort;

/** The file the operator applies: the template with one comment of its own. */
const EDITED = OME_TEMPLATE.replace('<Name>SwarmHlsStreamOME</Name>', '<!-- mine --><Name>SwarmHlsStreamOME</Name>');

class ScriptedWatcher implements EngineWatcher {
  answers = true;
  readonly probed: { port: number; budgetMs: number }[] = [];

  async inspect(): Promise<ContainerState | null> {
    return RUNNING;
  }

  async logs(): Promise<string> {
    return '';
  }

  async reachable(port: number, budgetMs: number): Promise<boolean> {
    this.probed.push({ port, budgetMs });
    return this.answers;
  }
}

async function setup() {
  const harness = profileServiceHarness([
    profileRow({
      name: 'ome1',
      kind: 'custom',
      port_slot: OME_SLOT,
      components: [OME_SERVICE, STREAM_UPLOADER_SERVICE],
    }),
    profileRow({ name: 'srs1', port_slot: 3 }),
  ]);
  await harness.versions.setContract(1, V3_CONTRACT);
  const operations = new InMemoryEngineConfigOperations(harness.profiles);
  const watcher = new ScriptedWatcher();
  const service = new EngineConfigService(
    harness.profiles.asRepository(),
    harness.containers.asRepository(),
    harness.orchestrator.asOrchestrator(),
    harness.versions,
    watcher,
    new EngineConfigChecker(async () => ({ code: 0, stdout: 'test is successful', stderr: '' })),
    harness.events,
    operations,
    { intervalMs: 5, durationMs: 25, probeBudgetMs: 40 },
  );
  const row = (name: string) => {
    const found = harness.profiles.rows.get(name);
    if (!found) throw new Error(`${name} is gone`);
    return found;
  };
  return { harness, operations, watcher, service, row, states: () => operations.rows.map((o) => o.state) };
}

const settle = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
}

describe('the HLS port after an OvenMediaEngine file applied', () => {
  it('is tried once the watch is over, within the budget, and an answer ends the rollout applied with no note', async () => {
    const { service, watcher, states, row } = await setup();

    await service.apply('ome1', EDITED);
    await until('the rollout to end', () => states()[0] === 'applied');

    assert.ok(HLS_PORT, 'the slot has an HLS port');
    assert.deepEqual(watcher.probed, [{ port: HLS_PORT, budgetMs: 40 }]);
    assert.equal(row('ome1').engine_config_error, null);
  });

  it('that does not answer ends the rollout applied with a note naming the port, and reverts nothing', async () => {
    const { service, harness, watcher, states, row } = await setup();
    watcher.answers = false;

    await service.apply('ome1', EDITED);
    await until('the rollout to end', () => states()[0] === 'applied');

    assert.equal(row('ome1').engine_config_state, 'applied');
    assert.match(row('ome1').engine_config_error ?? '', new RegExp(`HLS port ${HLS_PORT} did not answer`));
    assert.match(row('ome1').engine_config_error ?? '', /diagnosis/);
    assert.equal(harness.orchestrator.deploys.length, 1, 'nothing was recreated');
    assert.equal(harness.profiles.engineConfigs.get('ome1'), EDITED, 'the file stays');
  });

  it('is not tried on a version whose port table publishes no HLS port, and leaves no note', async () => {
    const { service, harness, watcher, states, row } = await setup();
    await harness.versions.setContract(1, {
      ...V3_CONTRACT,
      ports: [{ name: 'SRS_SRT_PORT', slotBase: 10000, defaultPort: 10080 }],
    });

    await service.apply('ome1', EDITED);
    await until('the rollout to end', () => states()[0] === 'applied');

    assert.deepEqual(watcher.probed, []);
    assert.equal(row('ome1').engine_config_error, null);
  });

  it('is never tried for an SRS deployment, whose parser was asked before the recreate', async () => {
    const { service, watcher, states } = await setup();

    await service.apply('srs1', 'listen 1935; # mine\n');
    await until('the rollout to end', () => states()[0] === 'applied');

    assert.deepEqual(watcher.probed, []);
  });
});
