/**
 * The keys a version's sample declares, as a deployment's settings page lists
 * them: in the sample's order, each under the section it sits in.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The version settings page reads the same samples and lists only the keys
 * they assign. A deployment's page also lists the keys upstream ships
 * commented out, such as `# LOCAL_BEE_UPLOADER=false`, because those are
 * settings a deployment can set too, and it groups every key under the
 * sample's own section rules, which the sample uses for the same purpose.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sampleCatalogOf } from '../../src/domain/versions/envSettingsText.js';

const STACK = fileURLToPath(new URL('../../swarm-hls-stream/', import.meta.url));

const SAMPLE = `# =====================================================
# Single .env for the entire monorepo
# =====================================================

# === Required, and the stamp purchase defaults ===

# The batch to publish with.
STAMP=

# === Stream Uploader ===

# The uploader's own Bee node, when it runs one.
# LOCAL_BEE_UPLOADER=false

# --- Logging --------------------------------------------------------------
# How much the uploader prints.
LOG_LEVEL=debug
# Shown commented out, and assigned below.
# LOG_FORMAT=json
LOG_FORMAT=
`;

describe('the keys a sample declares, by section', () => {
  it('files every key under the titled rule above it, and none under a banner with no title', () => {
    const sections = Object.fromEntries(sampleCatalogOf(SAMPLE).map((entry) => [entry.key, entry.section]));

    assert.deepEqual(sections, {
      STAMP: 'Required, and the stamp purchase defaults',
      LOCAL_BEE_UPLOADER: 'Stream Uploader',
      LOG_LEVEL: 'Logging',
      LOG_FORMAT: 'Logging',
    });
  });

  it('lists a key shown only commented out, with the example as its value', () => {
    const entry = sampleCatalogOf(SAMPLE).find((candidate) => candidate.key === 'LOCAL_BEE_UPLOADER');

    assert.deepEqual(entry, {
      key: 'LOCAL_BEE_UPLOADER',
      section: 'Stream Uploader',
      description: "The uploader's own Bee node, when it runs one.",
      value: null,
      example: 'false',
    });
  });

  it('keeps what the sample assigns for a key it also shows commented out, and the example beside it', () => {
    const entry = sampleCatalogOf(SAMPLE).find((candidate) => candidate.key === 'LOG_FORMAT');

    assert.equal(entry?.value, '');
    assert.equal(entry?.example, 'json');
  });

  it('keeps the sample order', () => {
    assert.deepEqual(sampleCatalogOf(SAMPLE).map((entry) => entry.key), ['STAMP', 'LOCAL_BEE_UPLOADER', 'LOG_LEVEL', 'LOG_FORMAT']);
  });

  it('reads the bundled sample the way its sections are written', () => {
    const catalog = sampleCatalogOf(readFileSync(`${STACK}.env.sample`, 'utf8'));
    const entry = (key: string) => catalog.find((candidate) => candidate.key === key);

    assert.equal(entry('BEE_URL')?.section, 'Stream Uploader');
    assert.equal(entry('BEE_RUNG_FULL_NODE')?.section, 'Per-rung Bee nodes');
    assert.equal(entry('ADMIN_API_URL')?.section, 'Admin mode');
    assert.equal(entry('LOG_LEVEL')?.section, 'Logging');
    assert.equal(entry('RPC_ENDPOINT')?.section, 'Bee Nodes (Docker deployment)');
    assert.equal(entry('BEE_GATEWAY_RPC_ENDPOINT')?.example, 'https://rpc.gnosischain.com');
    assert.equal(entry('LOCAL_BEE_UPLOADER')?.value, null);
  });
});
