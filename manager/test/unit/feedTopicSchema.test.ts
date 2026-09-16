/**
 * A feed topic the stack's deploy script would refuse.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The manager hands the topic to that script as `--feed-topic=<value>`, and
 * _lib.sh's require_override_shape refuses the flag outside
 * /^[A-Za-z0-9._-]{1,64}$/. A value the schema takes and the flag does not is
 * stored here and then fails on the deployment host, as a red deployment
 * nobody can run, rather than as an answer to the request that created it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProfileSchema } from '../../src/schemas/profile.js';

const BASE = { name: 'stage', kind: 'custom', components: ['srs'] };

/** The shape in the words the deploy script itself uses for it. */
const SHAPE_MESSAGE =
  /letters, digits, dot, underscore or hyphen, at most 64 characters/;

const REFUSED = [
  ['a space', 'my stream'],
  ['a slash', 'stream/1'],
  ['a dollar sign', '$(whoami)'],
  ['65 characters', 'a'.repeat(65)],
] as const;

const ACCEPTED = [
  ['a plain word', 'swarm-stream'],
  ['dot, underscore and hyphen together', 'a.b_c-1'],
  ['exactly 64 characters', 'a'.repeat(64)],
] as const;

describe('the feed topic a create body may carry', () => {
  for (const [label, topic] of REFUSED) {
    it(`refuses ${label}, as the deploy script does`, async () => {
      await assert.rejects(
        () => createProfileSchema.validate({ ...BASE, feed_topic: topic }),
        SHAPE_MESSAGE,
      );
    });
  }

  for (const [label, topic] of ACCEPTED) {
    it(`keeps ${label}`, async () => {
      const parsed = await createProfileSchema.validate({ ...BASE, feed_topic: topic });
      assert.equal(parsed.feed_topic, topic);
    });
  }
});
