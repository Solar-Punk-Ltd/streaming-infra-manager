/**
 * One representation of "this deployment names no chain endpoint".
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The column carries a CHECK that the value looks like an http(s) URL, so a
 * blank string reaching the write is a raw Postgres error rather than an
 * answer. The drawer already sends null for an emptied field, but the API takes
 * a body from anywhere, and `nullify` maps only `undefined`. The schema is the
 * boundary, so blank becomes null here and null is the only way to say none.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProfileSchema, updateProfileSchema } from '../../src/schemas/profile.js';

const BASE = { name: 'stage', kind: 'custom', components: ['srs'] };

describe('the chain endpoint a body may carry', () => {
  for (const [label, schema, base] of [
    ['create', createProfileSchema, BASE],
    ['update', updateProfileSchema, { kind: 'custom', components: ['srs'] }],
  ] as const) {
    it(`turns a blank ${label} value into null rather than storing one`, async () => {
      for (const blank of ['', '   ', '\t']) {
        const parsed = await schema.validate({ ...base, rpc_endpoint: blank });
        assert.equal(parsed.rpc_endpoint, null, `${label} kept ${JSON.stringify(blank)}`);
      }
    });

    it(`keeps a real ${label} endpoint, trimmed`, async () => {
      const parsed = await schema.validate({ ...base, rpc_endpoint: '  http://host.docker.internal:9000  ' });
      assert.equal(parsed.rpc_endpoint, 'http://host.docker.internal:9000');
    });

    it(`still refuses a ${label} value that is not an address`, async () => {
      await assert.rejects(
        () => schema.validate({ ...base, rpc_endpoint: 'rpc.gnosischain.com' }),
        /rpc_endpoint/,
      );
    });
  }
});
