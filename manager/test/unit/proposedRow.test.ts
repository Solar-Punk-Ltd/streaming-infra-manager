/**
 * Which state an edit is judged on: the one it proposes, not the one stored.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The edit handed the stored row to the uploader gate and the claim, then
 * wrote and deployed the new one. A dead stamp could not be replaced through
 * Edit, because the gate refused the stamp being replaced, and a live stamp
 * let a dead replacement through, because the gate never saw it. The same
 * held for every member of a group edit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StampNotUsableError } from '../../src/domain/errors/index.js';
import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const DEAD = 'd'.repeat(64);
const LIVE = 'a'.repeat(64);

/** A node that refuses one batch the way a real one refuses an expired one. */
const nodeRefusing =
  (dead: string, onlyFor: string | null = null) =>
  async (profile: Profile): Promise<void> => {
    if (profile.stamp_id === dead && (onlyFor === null || profile.name === onlyFor)) {
      throw new StampNotUsableError(profile.name, 'the batch has expired');
    }
  };

const streamer = (over: Partial<Profile> = {}): Profile =>
  makeProfile({ name: 'stage', stamp_id: LIVE, notes: 'before', ...over });

const EDITABLE_FIELDS = [
  'notes',
  'feed_owner',
  'feed_topic',
  'private_key',
  'public_key',
  'stamp_id',
  'bee_publishers',
  'bee_url',
  'srt_passphrase',
] as const;

/** The fields a PUT replaces, as the gate and the deploy saw them. */
function editableFieldsOf(row: Profile | undefined): Record<string, unknown> {
  return Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, row?.[field]]));
}

describe('an edit is judged on the state it proposes', () => {
  it('replaces a dead stamp with a live one through Edit', async () => {
    const harness = profileServiceHarness([streamer({ stamp_id: DEAD })]);
    harness.orchestrator.gate = nodeRefusing(DEAD);

    await harness.service.update('stage', { stamp_id: LIVE });

    assert.equal(harness.orchestrator.judged[0]?.stamp_id, LIVE, 'the gate saw the stamp the edit proposes');
    assert.equal(harness.profiles.rows.get('stage')?.stamp_id, LIVE);
    assert.deepEqual(harness.orchestrator.deploys.map((deploy) => deploy.profileName), ['stage']);
  });

  it('refuses a dead stamp in place of a live one, and changes nothing', async () => {
    const harness = profileServiceHarness([streamer()]);
    harness.orchestrator.gate = nodeRefusing(DEAD);

    await assert.rejects(
      harness.service.update('stage', { stamp_id: DEAD, notes: 'after' }),
      StampNotUsableError,
    );

    assert.deepEqual(harness.orchestrator.reserved, [], 'no claim was taken');
    assert.deepEqual(harness.profiles.updateEditableCalls, [], 'nothing was written');
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.equal(harness.profiles.statusOf('stage'), 'RUNNING');
    assert.equal(harness.profiles.rows.get('stage')?.stamp_id, LIVE);
    assert.equal(harness.profiles.rows.get('stage')?.notes, 'before');
  });

  it('hands one and the same state to the gate, the claim and the deploy', async () => {
    const harness = profileServiceHarness([streamer()]);
    harness.orchestrator.gate = async () => undefined;

    await harness.service.update('stage', { stamp_id: LIVE, notes: 'after' });

    const judged = harness.orchestrator.judged[0];
    const deployed = harness.orchestrator.deployedRows[0];
    assert.equal(judged?.notes, 'after');
    assert.equal(judged?.stamp_id, LIVE);
    assert.equal(judged?.bee_url, null, 'a field the body leaves out is null, as the PUT stores it');
    assert.equal(deployed?.notes, 'after');
    assert.equal(deployed?.stamp_id, LIVE);
    // Every editable field, not the two looked at above: the deploy runs on
    // exactly the state the gate judged.
    assert.deepEqual(editableFieldsOf(deployed), editableFieldsOf(judged));
    assert.equal(harness.profiles.rows.get('stage')?.notes, 'after');
  });
});

describe('a group edit is judged on the state it proposes, member by member', () => {
  function withGroup() {
    const harness = profileServiceHarness([
      streamer({ name: 'pool-1', group_id: 1 }),
      streamer({ name: 'pool-2', group_id: 1 }),
    ]);
    harness.groups.groups.push({
      id: 1,
      name: 'pool',
      size: 2,
      kind: 'standard',
      created_at: new Date(0),
    });
    return harness;
  }

  it('shows the gate the stamp the edit proposes for every member', async () => {
    const harness = withGroup();
    harness.orchestrator.gate = async () => undefined;

    await harness.service.updateGroupConfig(1, { stamp_id: DEAD });

    assert.deepEqual(
      harness.orchestrator.judged.map((row) => [row.name, row.stamp_id]),
      [['pool-1', DEAD], ['pool-2', DEAD]],
    );
  });

  it('writes and deploys no member when the node refuses one member, and gives the claims back', async () => {
    const harness = withGroup();
    harness.orchestrator.gate = nodeRefusing(DEAD, 'pool-2');

    await assert.rejects(
      harness.service.updateGroupConfig(1, { stamp_id: DEAD }),
      StampNotUsableError,
    );

    assert.deepEqual(harness.groups.configWrites, []);
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.deepEqual(harness.orchestrator.cancelled, ['pool-1']);
    assert.equal(harness.profiles.statusOf('pool-1'), 'RUNNING');
    assert.equal(harness.profiles.rows.get('pool-1')?.stamp_id, LIVE);
  });
});
