/**
 * Ports and the slot ceiling come from the version, not from a table in the
 * manager.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * main-v3 publishes a tenth port, SRS's stats API at 10009 plus ten per slot,
 * and refuses slots above 99. A manager that kept main-v2's table would report
 * a container without that port and hand out slot 100 to a version whose
 * deploy script then refuses it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { AllSlotsUsedError } from '../../src/domain/errors/index.js';
import {
  BUNDLED_PORT_TABLE,
  maxSlotOf,
  omePortsFor,
  portTableOf,
} from '../../src/domain/versions/portTable.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { OrchestratorHarness } from '../support/orchestratorHarness.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const root = mkdtempSync(join(tmpdir(), 'port-table-'));
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);

const V3_CONTRACT: StackContract = {
  ports: [
    ...BUNDLED_PORT_TABLE.map((port, index) => ({
      ...port,
      defaultPort: [3000, 10080, 1935, 8080, 5173, 1633, 1634, 1733, 1734][index]!,
    })),
    { name: 'SRS_HTTP_API_PORT', defaultPort: 1985, slotBase: 10009 },
  ],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false },
  chequebookMinBzz: null,
  warnings: [],
};

async function v3On(harness: { versions: OrchestratorHarness['versions'] }): Promise<number> {
  const row = await harness.versions.insert({
    name: 'main-v3',
    gitRef: 'main-v3',
    rootPath: root,
  });
  await harness.versions.markBuilt(row.id, {
    commitSha: 'abc1234',
    contract: V3_CONTRACT,
  });
  return row.id;
}

describe('the port table of a version', () => {
  it('is the bundled one when the contract is missing or names no ports', () => {
    assert.equal(portTableOf(null), BUNDLED_PORT_TABLE);
    assert.equal(portTableOf({ ...V3_CONTRACT, ports: [] }), BUNDLED_PORT_TABLE);
    assert.equal(portTableOf(V3_CONTRACT), V3_CONTRACT.ports);
  });

  it('caps the slot at what the version accepts, 999 without a contract', () => {
    assert.equal(maxSlotOf(null), 999);
    assert.equal(maxSlotOf(V3_CONTRACT), 99);
  });

  it('gives OvenMediaEngine the SRS ports of the slot, and nothing for slot 0', () => {
    assert.deepEqual(omePortsFor(3, BUNDLED_PORT_TABLE), {
      omeSrtPort: 10031,
      omeHlsPort: 10033,
    });
    assert.deepEqual(omePortsFor(0, BUNDLED_PORT_TABLE), {});
  });
});

describe('the container snapshot after a deploy', () => {
  it('carries the tenth port of a main-v3 deployment, shifted by its slot', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const harness = orchestratorHarness([]);
    const v3 = await v3On(harness);
    const stored = makeProfile({
      name: 'stage',
      port_slot: 3,
      stamp_id: 'a'.repeat(64),
      stack_version_id: v3,
    });
    harness.profiles.rows.set('stage', stored);

    await harness.orchestrator.startDeploy(stored, ['srs']);
    harness.runner.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const srs = harness.containers.snapshots.find((s) => s.service === 'srs');
    assert.equal(srs?.ports.SRS_SRT_PORT, 10031);
    assert.equal(srs?.ports.SRS_HTTP_API_PORT, 10039);
  });

  it('has no such port for a bundled deployment', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const stored = makeProfile({
      name: 'plain',
      port_slot: 3,
      stamp_id: 'a'.repeat(64),
    });
    const harness = orchestratorHarness([stored]);

    await harness.orchestrator.startDeploy(stored, ['srs']);
    harness.runner.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const srs = harness.containers.snapshots.find((s) => s.service === 'srs');
    assert.equal(srs?.ports.SRS_SRT_PORT, 10031);
    assert.equal(srs?.ports.SRS_HTTP_API_PORT, undefined);
  });
});

describe('the slot ceiling on creation', () => {
  it('refuses a deployment past the ceiling of its version, naming the ceiling', async () => {
    const harness = profileServiceHarness([
      makeProfile({ name: 'one', port_slot: 1 }),
      makeProfile({ name: 'two', port_slot: 2 }),
    ]);
    const capped = await harness.versions.insert({
      name: 'small',
      gitRef: 'small',
      rootPath: '/versions/small',
    });
    await harness.versions.markBuilt(capped.id, {
      commitSha: 'abc1234',
      contract: { ...V3_CONTRACT, maxSlot: 2 },
    });

    await assert.rejects(
      harness.service.create({
        name: 'three',
        kind: 'viewer',
        stack_version_id: capped.id,
      }),
      (err: unknown) => err instanceof AllSlotsUsedError && /1-2 /.test(err.message),
    );
    assert.equal(harness.profiles.rows.has('three'), false);
  });
});
