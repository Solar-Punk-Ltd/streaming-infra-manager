/**
 * The two columns T27 adds, read out of the migration's own text.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The choices a node mode and an endpoint source may take are written in three
 * places: the shared rules in common, the request schema that calls them, and a
 * CHECK on each column. A rule written three times is a rule that drifts, so
 * the CHECKs are compared against the shared lists here rather than read by
 * eye. The pairing between the source and the stored address is the one that
 * matters most: it is what stops a row saying it takes the manager's endpoint
 * while carrying an address of its own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NODE_MODES,
  RPC_ENDPOINT_SOURCES,
} from '@streaming-infra-manager/common';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  '..',
  '..',
  'src',
  'migrations',
  '035_profile_node_mode.sql',
);

const sql = () => readFileSync(MIGRATION, 'utf8');

/** The values a column's `IN (...)` CHECK admits, in the order it lists them. */
function admitted(column: string, text: string): string[] {
  const found = new RegExp(`${column} IN \\(([^)]+)\\)`).exec(text);
  assert.ok(found, `the migration declares no IN CHECK over ${column}`);
  return found[1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
}

describe('the node mode column', () => {
  it('admits exactly the modes the shared rule knows', () => {
    assert.deepEqual(admitted('node_mode', sql()), [...NODE_MODES]);
  });

  it('is nullable and backfills nothing, so an existing deployment reads right', () => {
    // NULL means "as the stack ships that node", light for a bee-uploader and
    // ultra-light for a gateway, which is what every stored row already does.
    assert.match(sql(), /node_mode TEXT\b/);
    assert.doesNotMatch(sql(), /UPDATE profiles SET node_mode/);
  });
});

describe('the endpoint source column', () => {
  it('admits exactly the sources the shared rule knows', () => {
    assert.deepEqual(
      admitted('rpc_endpoint_source', sql()),
      [...RPC_ENDPOINT_SOURCES],
    );
  });

  it('defaults to the stack, which is what every stored row does today', () => {
    assert.match(sql(), /rpc_endpoint_source TEXT NOT NULL DEFAULT 'stack'/);
  });

  it('backfills a deployment that already names an address to custom', () => {
    assert.match(
      sql(),
      /UPDATE profiles\s+SET rpc_endpoint_source = 'custom'\s+WHERE rpc_endpoint IS NOT NULL/,
    );
  });

  it('pairs custom with a stored address, both ways', () => {
    // Without the second direction a row could say it takes the manager's
    // endpoint and carry an address of its own, and nothing would say which of
    // the two the deploy used.
    assert.match(
      sql(),
      /CHECK \(\(rpc_endpoint_source = 'custom'\) = \(rpc_endpoint IS NOT NULL\)\)/,
    );
  });
});
