import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { profileServiceHarness } from '../support/profileServiceHarness.js';

const BAD_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 100,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: false, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: null, ome: null },
  warnings: [],
  allocationProblem: 'deploy/docker-compose.yml line 6: cannot read the published port',
};

describe('allocation admission', () => {
  for (const action of ['deployment', 'group', 'member'] as const) {
    for (const obstacle of ['contract', 'missing', 'empty', 'inventory'] as const) {
      it(`refuses a new ${action} before any write or deploy when the ${obstacle} is not ready`, async () => {
        const harness = profileServiceHarness();
        const group = action === 'member'
          ? (await harness.service.createGroup({ group_name: 'pool', size: 1, kind: 'viewer' })).group
          : null;
        if (obstacle !== 'inventory') {
          const bundled = await harness.versions.findDefault();
          bundled!.contract = obstacle === 'missing' ? null
            : { ...BAD_CONTRACT, allocationProblem: obstacle === 'empty' ? null : BAD_CONTRACT.allocationProblem };
        } else {
          harness.profiles.reservations.seededAt = null;
        }
        const before = {
          profiles: [...harness.profiles.rows.values()],
          groups: [...harness.groups.groups],
          ports: [...harness.profiles.reservations.rows],
          deploys: [...harness.orchestrator.deploys],
        };
        const create = () => action === 'deployment'
          ? harness.service.create({ name: 'stage', kind: 'viewer' })
          : action === 'group'
            ? harness.service.createGroup({ group_name: 'stage', size: 2, kind: 'viewer' })
            : harness.service.addGroupMembers(group!.id, 1);

        await assert.rejects(create, obstacle === 'contract'
          ? /deploy\/docker-compose\.yml line 6: cannot read the published port/
          : obstacle === 'inventory'
            ? /reservation inventory is still being built/
            : /no readable port table/);
        assert.deepEqual([...harness.profiles.rows.values()], before.profiles);
        assert.deepEqual(harness.groups.groups, before.groups);
        assert.deepEqual(harness.profiles.reservations.rows, before.ports);
        assert.deepEqual(harness.orchestrator.deploys, before.deploys);
      });
    }
  }

  it('allows the same request once inventory seeding completes', async () => {
    const harness = profileServiceHarness();
    harness.profiles.reservations.seededAt = null;
    await assert.rejects(
      harness.service.create({ name: 'stage', kind: 'viewer' }),
      /reservation inventory is still being built/,
    );
    await harness.profiles.reservations.markInventorySeeded();

    const created = await harness.service.create({ name: 'stage', kind: 'viewer' });
    assert.equal(created.port_slot, 1);
    assert.ok(harness.profiles.reservations.rows.length > 0);
  });
});
