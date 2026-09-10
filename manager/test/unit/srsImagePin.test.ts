/**
 * The SRS image the T02 harness runs and the T01 observations were made on,
 * read off the three places that name it.
 *
 * The harness rests on one sentence: the parser it questions is the parser a
 * deployment gets. That sentence is only true while the digest it pins is the
 * digest the stack's own tag resolves to, and the same digest the recorded
 * engine observations were taken on. Three files carry it, so three files can
 * drift apart, and a digest of a real but different image refuses and accepts
 * exactly like the right one. Nothing here reaches a registry: the live
 * resolution is recorded in the script header with its date, and this file
 * pins that the three places say one thing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, '..', '..', ...parts), 'utf8');

const script = read('test', 'docker', 'srs-check-isolation.sh');
const startupFailure = read('test', 'integration', 'engine-startup-failure.test.ts');
const ci = read('..', 'docs', 'ci.md');

const SRS_DIGEST_RE = /ossrs\/srs@(sha256:[0-9a-f]{64})/g;
/** The same reference, without the flag that carries state from one test into the next. */
const ONE_SRS_DIGEST = /ossrs\/srs@sha256:[0-9a-f]{64}/;
/** The pin table row for the tag, as `| \`ossrs/srs:6\` | \`sha256:...\` | date |`. */
const CI_ROW_RE = /\|\s*`ossrs\/srs:6`\s*\|\s*`(sha256:[0-9a-f]{64})`\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/;

function digestsIn(text: string): string[] {
  return [...text.matchAll(SRS_DIGEST_RE)].map(([, digest]) => digest);
}

const pinned = digestsIn(script);
const imageLine = script.split('\n').find((line) => line.startsWith('IMAGE=')) ?? '';

describe('the SRS image the T02 harness pins', () => {
  it('names one digest and reaches the image by no other name', () => {
    assert.equal(new Set(pinned).size, 1, `the script names ${pinned.length} digests: ${pinned.join(' ')}`);
    assert.match(imageLine, ONE_SRS_DIGEST);
    assert.equal(/ossrs\/srs:/.test(imageLine), false, `the image is reached by tag: ${imageLine}`);
  });

  it('records the day the tag was resolved to it, because a tag moves and a digest does not', () => {
    assert.match(script, /resolved to this manifest list on \d{4}-\d{2}-\d{2}/);
  });
});

describe('the places that have to agree with it', () => {
  it('is the digest the T01 startup observations were made on', () => {
    const observed = digestsIn(startupFailure);
    assert.deepEqual(
      [...new Set(observed)],
      [pinned[0]],
      'the parse and the start were recorded on an image the harness no longer runs',
    );
  });

  it('is the digest the pin table in docs/ci.md carries, with the date it was resolved', () => {
    const row = ci.match(CI_ROW_RE);
    assert.ok(row, 'docs/ci.md has no pin row for ossrs/srs:6');
    assert.equal(row[1], pinned[0], 'the pin table names an image the harness does not run');
    assert.match(row[2], /^\d{4}-\d{2}-\d{2}$/);
  });
});
