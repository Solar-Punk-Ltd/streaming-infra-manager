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

/**
 * Column names in the shared SELECT list. An expression is counted by its
 * alias, which is the name the row carries it under: `(engine_config IS NOT
 * NULL) AS has_engine_config` is the field `has_engine_config`.
 */
function selectExpressions(sql: string): string[] {
  const expressions: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") quoted = !quoted;
    else if (!quoted && character === '(') depth += 1;
    else if (!quoted && character === ')') depth -= 1;
    else if (!quoted && depth === 0 && character === ',') {
      expressions.push(sql.slice(start, index));
      start = index + 1;
    }
  }
  expressions.push(sql.slice(start));
  return expressions;
}

const selected = (): string[] =>
  selectExpressions(PROFILE_COLUMNS)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => c.split(/\s+AS\s+/i).pop()!);

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

/**
 * Columns whose value must never be selected onto a profile row.
 *
 * Each is read on its own, beside the row: `private_key` through
 * ProfileRepository.privateKeyOf, `stack_secrets` through stackSecretsOf,
 * `engine_config` through engineConfigOf, `srt_passphrase` through
 * srtPassphraseOf and `stack_settings_secret` through stackSettingsForDeploy.
 *
 * The passphrase has a reader the others do not, the page that builds the
 * broadcaster's SRT URL, and that page asks for it one deployment at a time
 * through GET /profiles/:name/srt-passphrase. It rode on the row until then,
 * which handed it to every signed-in page on every list and every status
 * change, for the sake of one operator about to publish.
 */
const SECRET_COLUMNS: readonly string[] = [
  'private_key',
  'stack_secrets',
  'engine_config',
  'srt_passphrase',
  'rpc_endpoint',
  'stack_settings_secret',
];

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

  it('selects no column whose value is a secret', () => {
    const leaked = SECRET_COLUMNS.filter((column) => selected().includes(column));
    assert.deepEqual(
      leaked,
      [],
      `PROFILE_COLUMNS selects ${leaked.join(', ')}. A row is answered to the ` +
        'browser and published to every event subscriber, so a secret selected ' +
        'here reaches every signed-in user on every list and every status change.',
    );
  });

  it('says whether the deployment holds a signing key, without the key', () => {
    assert.ok(
      selected().includes('has_private_key'),
      'the row has to say whether a key is stored, so the edit drawer can mask ' +
        'the field it must not be sent',
    );
  });

  it('says whether the deployment holds an SRT passphrase, without the passphrase', () => {
    assert.ok(
      selected().includes('has_srt_passphrase'),
      'the row has to say whether a passphrase is stored, so the drawer knows ' +
        'which pass mode the deployment is on without being handed the value',
    );
  });

  it('describes a custom RPC endpoint without selecting its URL', () => {
    assert.ok(
      selected().includes('has_rpc_endpoint'),
      'the row has to say whether a custom endpoint is stored so an unchanged edit can keep it',
    );
    assert.ok(
      selected().includes('rpc_endpoint_host'),
      'the row has to show the endpoint host without exposing a key in its path',
    );
  });

  it('treats a backslash as a URL path boundary before selecting the host', () => {
    assert.match(
      PROFILE_COLUMNS,
      /replace\(rpc_endpoint, chr\(92\), '\/'\)/i,
      'WHATWG URL parsing treats a backslash after an HTTP host as a slash, so the SQL projection must do the same before it returns public metadata',
    );
  });

  it('carries the port-slot advisory lock key, shared by both repositories', () => {
    // Both repositories allocate port slots under this lock; two different
    // values would mean two locks and no mutual exclusion.
    assert.equal(PROFILE_SLOT_LOCK_KEY, 0x70726f66);
  });
});
