/**
 * A new deployment runs the version it was made on.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The wizard sends the version it picked, or nothing for the default. Either
 * way the row has to carry a version that finished building, because every
 * script the orchestrator runs for the deployment comes out of that version's
 * checkout, and a building version has no checkout to run anything from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { InvalidStackVersionError } from '../../src/domain/errors/index.js';
import {
  profileServiceHarness,
  type ProfileServiceHarness,
} from '../support/profileServiceHarness.js';

const EMPTY_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 999,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: false, chequebookGate: false },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: null, ome: null },
  warnings: [],
};

async function addVersion(
  harness: ProfileServiceHarness,
  name: string,
  status: 'ready' | 'building' | 'failed',
): Promise<number> {
  const row = await harness.versions.insert({
    name,
    gitRef: name,
    rootPath: `/versions/${name}`,
  });
  if (status === 'ready') {
    await harness.versions.markBuilt(row.id, {
      commitSha: 'abc1234',
      contract: EMPTY_CONTRACT,
    });
  }
  if (status === 'failed') {
    await harness.versions.markFailed(row.id, 'the build broke');
  }
  return row.id;
}

describe('the version a new deployment runs', () => {
  it('is the default version when none is asked for', async () => {
    const harness = profileServiceHarness();
    const bundled = await harness.versions.findDefault();

    const profile = await harness.service.create({ name: 'stage', kind: 'viewer' });

    assert.equal(profile.stack_version_id, bundled?.id);
    assert.deepEqual(harness.orchestrator.deploys.map((d) => d.profileName), [
      'stage',
    ]);
  });

  it('is the version asked for', async () => {
    const harness = profileServiceHarness();
    const v3 = await addVersion(harness, 'main-v3', 'ready');

    const profile = await harness.service.create({
      name: 'stage',
      kind: 'viewer',
      stack_version_id: v3,
    });

    assert.equal(profile.stack_version_id, v3);
    assert.equal(harness.profiles.rows.get('stage')?.stack_version_id, v3);
  });

  it('cannot be a version that is still building, and nothing is inserted', async () => {
    const harness = profileServiceHarness();
    const building = await addVersion(harness, 'next', 'building');

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'viewer',
        stack_version_id: building,
      }),
      (err: unknown) =>
        err instanceof InvalidStackVersionError &&
        /next is building/.test(err.reason),
    );

    assert.equal(harness.profiles.rows.size, 0);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('cannot be a version whose build failed', async () => {
    const harness = profileServiceHarness();
    const failed = await addVersion(harness, 'broken', 'failed');

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'viewer',
        stack_version_id: failed,
      }),
      InvalidStackVersionError,
    );
  });

  it('cannot be a version that does not exist', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'viewer',
        stack_version_id: 404,
      }),
      (err: unknown) =>
        err instanceof InvalidStackVersionError &&
        /Stack version 404 does not exist/.test(err.reason),
    );
  });

  it('is shared by every member of a group, including one added later', async () => {
    const harness = profileServiceHarness();
    const v3 = await addVersion(harness, 'main-v3', 'ready');

    const { group, profiles } = await harness.service.createGroup({
      group_name: 'pool',
      size: 2,
      kind: 'viewer',
      stack_version_id: v3,
    });
    const added = await harness.service.addGroupMembers(group.id, 1);

    assert.deepEqual(
      [...profiles, ...added.profiles].map((member) => member.stack_version_id),
      [v3, v3, v3],
    );
  });
});
