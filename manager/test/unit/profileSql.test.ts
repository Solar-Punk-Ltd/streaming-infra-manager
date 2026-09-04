/**
 * The shared `profiles` column list.
 *
 * This exists because the list was once duplicated — ProfileRepository and
 * DeploymentGroupRepository each kept a private copy — and the copies drifted:
 * `bee_publishers` and `bee_url` were added to one and not the other. A group
 * config PATCH then returned member rows with both fields `undefined`, and
 * because `writeProfileEnv` rebuilds `.env.<profile>` from a fresh copy of the
 * base `.env`, the keys were dropped from the deployed environment while the
 * database and the UI still showed them set.
 *
 * Sharing the constant stops the two from disagreeing. This test is about the
 * other half of that bug: a column the list forgets entirely. It reads the
 * field names off the `Profile` interface in the type source and asserts the
 * SELECT list covers every one, so adding a column to the row type without
 * adding it here fails here rather than silently at deploy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILE_COLUMNS,
  PROFILE_SLOT_LOCK_KEY,
} from '../../src/domain/profileSql.js';

const here = dirname(fileURLToPath(import.meta.url));
const INTERFACES = join(here, '..', '..', 'src', 'types', 'interfaces.ts');

/** Column names in the shared SELECT list. */
const selected = (): string[] =>
  PROFILE_COLUMNS.split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/**
 * Field names declared on `export interface Profile`, read from the source
 * rather than a value — the interface is erased at runtime, and a hand-kept
 * duplicate list here would be the very drift this test exists to catch.
 */
function profileFields(): string[] {
  const src = readFileSync(INTERFACES, 'utf8');
  const start = src.indexOf('export interface Profile {');
  assert.notEqual(
    start,
    -1,
    'could not find `export interface Profile` — did it move?',
  );
  const body = src.slice(start, src.indexOf('\n}', start));

  const fields: string[] = [];
  for (const raw of body.split('\n').slice(1)) {
    const line = raw.trim();
    // Skip the doc comments that sit between fields.
    if (!line || line.startsWith('*') || line.startsWith('/')) continue;
    const match = /^([a-z_][a-z0-9_]*)\??\s*:/i.exec(line);
    if (match) fields.push(match[1]!);
  }
  assert.ok(
    fields.length > 10,
    `parsed only ${fields.length} fields — parser is wrong`,
  );
  return fields;
}

describe('PROFILE_COLUMNS — the shared profiles SELECT list', () => {
  it('selects every field the Profile row type declares', () => {
    const missing = profileFields().filter((f) => !selected().includes(f));
    assert.deepEqual(
      missing,
      [],
      `Profile declares ${missing.join(', ')} but PROFILE_COLUMNS does not select ` +
        `${missing.length === 1 ? 'it' : 'them'}. A column missing here comes back ` +
        `undefined and is dropped from .env.<profile> on the next deploy.`,
    );
  });

  it('selects nothing the row type does not declare', () => {
    const fields = profileFields();
    const extra = selected().filter((c) => !fields.includes(c));
    assert.deepEqual(
      extra,
      [],
      `PROFILE_COLUMNS selects unknown column(s): ${extra.join(', ')}`,
    );
  });

  it('names the two columns whose omission caused the bug this guards', () => {
    // Explicit, so the regression that motivated the constant is named and not
    // merely implied by the generic check above.
    assert.ok(
      selected().includes('bee_publishers'),
      'bee_publishers must be selected',
    );
    assert.ok(selected().includes('bee_url'), 'bee_url must be selected');
  });

  it('carries the port-slot advisory lock key, shared by both repositories', () => {
    // Both repositories allocate port slots under this lock; two different
    // values would mean two locks and no mutual exclusion.
    assert.equal(PROFILE_SLOT_LOCK_KEY, 0x70726f66);
  });
});
