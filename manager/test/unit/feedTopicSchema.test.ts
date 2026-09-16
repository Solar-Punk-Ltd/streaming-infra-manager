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
 *
 * Three places state that one shape now: the script, the request schema and a
 * CHECK on the column. The last two are read from their own source files below
 * and compared, because a rule written twice is a rule that drifts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createProfileSchema } from '../../src/schemas/profile.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SOURCE = join(here, '..', '..', 'src', 'schemas', 'profile.ts');
const MIGRATION = join(
  here,
  '..',
  '..',
  'src',
  'migrations',
  '033_profile_feed_topic_shape.sql',
);

/** The shape the request refuses on, read from its own source, never copied. */
function schemaShape(): string {
  const found = readFileSync(SCHEMA_SOURCE, 'utf8').match(
    /const FEED_TOPIC_RE = \/(.+)\/;/,
  );
  assert.ok(found, 'FEED_TOPIC_RE is gone from the profile schema, or was renamed');
  return found[1]!;
}

/** The shape the column refuses on, read out of the migration's own CHECK. */
function columnShape(sql: string): string {
  const found = sql.match(/feed_topic ~ '([^']+)'/);
  assert.ok(found, 'the migration declares no CHECK over feed_topic');
  return found[1]!;
}

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

describe('the CHECK the column carries', () => {
  it('refuses exactly what the request refuses', () => {
    assert.equal(columnShape(readFileSync(MIGRATION, 'utf8')), schemaShape());
  });

  it('leaves NULL alone, which is every deployment that names no topic', () => {
    assert.match(readFileSync(MIGRATION, 'utf8'), /feed_topic IS NULL/);
  });

  it('is declared NOT VALID, so a row stored before the rule cannot stop the upgrade', () => {
    // An existing row outside the shape is a deployment somebody is running.
    // NOT VALID holds new writes to the rule and leaves such a row where it is,
    // for an operator to find with the census query the migration names.
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /NOT VALID/);
    assert.match(sql, /SELECT name, feed_topic FROM profiles/);
  });
});
