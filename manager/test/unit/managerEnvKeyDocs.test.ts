/**
 * Every environment variable the manager reads is written down somewhere.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The keys are split over two documents on purpose: manager/.env.sample holds
 * the ones an operator sets by hand, and manager/README.md's Environment
 * section holds the ones compose sets and the ones that must never be written
 * into a committed file. A key in neither is one no reader can discover
 * without grepping the source, which is what MANAGER_HOST, HOST_PROC and
 * HOST_ROOTFS were until 2026-09-17. So the assertion is that each key is
 * named in one of the two, never that it sits in a particular table.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../../.env.sample', import.meta.url));
const README = fileURLToPath(new URL('../../README.md', import.meta.url));

/** `src/utils/config.ts` reads its keys through these two helpers of its own rather than inline. */
const CONFIG_FILE = 'utils/config.ts';
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\['([A-Z][A-Z0-9_]*)'\])/g;
const CONFIG_HELPER_READ = /\b(?:required|optional)\(\s*'([A-Z][A-Z0-9_]*)'/g;

function keysReadUnderSrc(): string[] {
  const keys = new Set<string>();
  for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const [, dotted, bracketed] of text.matchAll(ENV_READ)) keys.add(dotted ?? bracketed);
    if (file === CONFIG_FILE) {
      for (const [, key] of text.matchAll(CONFIG_HELPER_READ)) keys.add(key);
    }
  }
  return [...keys].sort();
}

describe('the manager documents the environment it reads', () => {
  it('names every key it reads in the sample or in the README', () => {
    const keys = keysReadUnderSrc();
    assert.ok(keys.length > 10, `only ${keys.length} keys were collected, so the documents are being held to nothing`);
    const written = readFileSync(SAMPLE, 'utf8') + readFileSync(README, 'utf8');
    assert.deepEqual(
      keys.filter((key) => !written.includes(key)),
      [],
      'the manager reads these and neither manager/.env.sample nor manager/README.md names them, so nobody can find them without reading the source',
    );
  });
});
