/**
 * Validation rules for ABR ladder groups.
 *
 * Unit test — no database, no Docker. `pnpm test` in manager/.
 *
 * The group-name length rule is the one worth pinning: it reaches across fields
 * via yup's `this.parent`, which fails silently if the schema shape changes, and
 * the failure it prevents is a check-constraint violation partway through
 * creating a group — some members inserted, some not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_LADDER_SIZE,
  LADDER_GROUP_NAME_MAX,
  ladderMemberNames,
} from '@streaming-infra-manager/common';

import { createGroupSchema } from '../../src/schemas/profile.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

async function accepts(body: unknown): Promise<boolean> {
  try {
    await createGroupSchema.validate(body, { abortEarly: false });
    return true;
  } catch {
    return false;
  }
}

describe('createGroupSchema — ABR ladder', () => {
  const atMax = 'a'.repeat(LADDER_GROUP_NAME_MAX);
  const oneOver = 'a'.repeat(LADDER_GROUP_NAME_MAX + 1);

  it('accepts a ladder whose group name is exactly at the cap', async () => {
    assert.equal(
      await accepts({ group_name: atMax, size: ABR_LADDER_SIZE, abr_ladder: true }),
      true,
    );
  });

  it('rejects a ladder one character over the cap', async () => {
    assert.equal(
      await accepts({ group_name: oneOver, size: ABR_LADDER_SIZE, abr_ladder: true }),
      false,
    );
  });

  it('leaves non-ladder groups on the ordinary 31-char limit', async () => {
    // The tighter cap exists only because a ladder appends `-<rung>`; a plain
    // fan-out group names members `-profile-N` and is not affected.
    assert.equal(await accepts({ group_name: oneOver, size: 2 }), true);
  });

  it('accepts an ordinary short ladder name', async () => {
    assert.equal(
      await accepts({ group_name: 'abr1', size: ABR_LADDER_SIZE, abr_ladder: true }),
      true,
    );
  });

  it('rejects publisher-ish component lists it cannot honour', async () => {
    // Components are fixed server-side for a ladder; anything sent is ignored,
    // but an invalid service name must still fail validation.
    assert.equal(
      await accepts({
        group_name: 'abr1',
        size: ABR_LADDER_SIZE,
        abr_ladder: true,
        components: ['not-a-service'],
      }),
      false,
    );
  });

  it('the cap is exactly the point where member names stop fitting', async () => {
    assert.ok(ladderMemberNames(atMax).every((n) => PROFILE_NAME_RE.test(n)));
    assert.ok(ladderMemberNames(oneOver).some((n) => !PROFILE_NAME_RE.test(n)));
  });
});
