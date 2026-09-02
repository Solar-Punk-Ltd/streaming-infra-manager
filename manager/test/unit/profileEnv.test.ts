/**
 * What writeProfileEnv puts in .env.<profile> for a pool-backed uploader.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Three things have to hold at once or the uploader on the other machine will
 * not start: BEE_PUBLISHERS reaches the file unquoted (deploy.sh's line parser
 * and compose both take an unquoted value literally, and the engine's own sample
 * writes it that way), ABR_ENABLED goes with it, and ABR_LADDER names exactly the
 * rungs the publishers cover — the uploader refuses any mismatch.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

// SUBMODULE is resolved when the module loads, so point it at a scratch
// directory before importing.
const root = mkdtempSync(join(tmpdir(), 'shls-'));
process.env.SHLS_ROOT = root;

// The one definition of the base .env every case starts from. Cases that need
// a different base overwrite the file; rewriting it before each test means
// they cannot leak into the next one — a failing assertion used to skip the
// inline restore that followed it, so one real failure reported as three, two
// of them pointing at code that was fine.
const BASE_ENV =
  'ENGINE=srs\nBEE_URL=http://bee-uploader:1633\nSTREAM_LIST_TOPIC=swarm-stream\n';
const writeBaseEnv = (contents = BASE_ENV) =>
  writeFileSync(join(root, '.env'), contents);

writeBaseEnv();

const { writeProfileEnv } = await import('../../src/utils/envUtils.js');

const BATCH = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map((rung, i) => `${rung}@http://65.108.40.58:${10015 + i * 10}<${BATCH(rung)}>`)
  .join(' ');

const lines = (path: string) => readFileSync(path, 'utf8').split('\n');
const lineFor = (path: string, key: string) =>
  lines(path).find((line) => line.startsWith(`${key}=`));

beforeEach(() => writeBaseEnv());

describe('writeProfileEnv — BEE_PUBLISHERS', () => {
  it('writes the publishers unquoted, with ABR_ENABLED and the shipped ABR_LADDER', () => {
    const path = writeProfileEnv('stage-a', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
    assert.equal(lineFor(path, 'ABR_ENABLED'), 'ABR_ENABLED=true');
    assert.equal(
      lineFor(path, 'ABR_LADDER'),
      'ABR_LADDER=1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700',
    );
    // The base env is still copied through.
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
  });

  it('leaves an inherited STAMP alone — an empty one is fatal upstream', () => {
    // Tempting to clear: the batch belongs to whatever the base .env was set up
    // for, not to this profile. But the uploader declares `stamp: required(…)`
    // and its required() throws on '', so a blank STAMP stops the container at
    // config load. Inert-but-wrong beats fatal until STAMP is made conditional
    // upstream.
    const foreign = 'f'.repeat(64);
    writeBaseEnv(`ENGINE=srs\nSTAMP=${foreign}\n`);
    const path = writeProfileEnv('stage-inherit', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
    });
    assert.equal(lineFor(path, 'STAMP'), `STAMP=${foreign}`);
    // No restore needed: beforeEach rewrites the base env for the next case.
  });

  it('trims the pasted value', () => {
    const path = writeProfileEnv('stage-b', {
      engine: 'srs',
      beePublishers: `  ${PUBLISHERS}\n`,
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
  });

  it('writes none of the three when the profile publishes through its own node', () => {
    const path = writeProfileEnv('stage-c', {
      engine: 'srs',
      stampId: BATCH('own'),
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), undefined);
    assert.equal(lineFor(path, 'ABR_ENABLED'), undefined);
    assert.equal(lineFor(path, 'ABR_LADDER'), undefined);
    assert.equal(lineFor(path, 'STAMP'), `STAMP=${BATCH('own')}`);
  });

  it('refuses a value the uploader would refuse, naming the reason', () => {
    const missing1080 = PUBLISHERS.split(' ').slice(0, 3).join(' ');
    assert.throws(
      () => writeProfileEnv('stage-d', { engine: 'srs', beePublishers: missing1080 }),
      /refusing to write BEE_PUBLISHERS.*missing 1080p/,
    );
  });

  it('refuses the OME engine — the ladder is SRS-only', () => {
    assert.throws(
      () => writeProfileEnv('stage-e', { engine: 'ome', beePublishers: PUBLISHERS }),
      /srs engine/,
    );
  });
});

describe('writeProfileEnv — BEE_URL', () => {
  it('writes an explicit external node', () => {
    const path = writeProfileEnv('ext-a', {
      engine: 'srs',
      beeUrl: 'http://10.0.0.7:1633',
      stampId: BATCH('360p'),
    });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://10.0.0.7:1633');
  });

  it('leaves the base env alone when none is set', () => {
    const path = writeProfileEnv('ext-b', { engine: 'srs' });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
  });

  it('yields to BEE_PUBLISHERS, which the uploader reads instead', () => {
    const path = writeProfileEnv('ext-c', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
      beeUrl: 'http://10.0.0.7:1633',
    });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
  });

  it('refuses an ssh target', () => {
    assert.throws(
      () => writeProfileEnv('ext-d', { engine: 'srs', beeUrl: 'http://deploy@10.0.0.7:1633' }),
      /refusing to write BEE_URL.*ssh user info/,
    );
  });

  it('writes a $ in the value literally, not as a replacement pattern', () => {
    // The base .env already carries a BEE_URL line, so this takes the upsert's
    // overwrite branch — the one that used to hand the value to String.replace
    // as a *replacement string*, where `$&` means "the text that matched".
    // `$` is legal in a URL path and beeUrlProblem accepts it, so the value
    // came back mangled: the old line spliced into the middle of the new one.
    const url = 'http://10.0.0.7:1633/$&$`x';
    const path = writeProfileEnv('ext-e', { engine: 'srs', beeUrl: url });
    assert.equal(lineFor(path, 'BEE_URL'), `BEE_URL=${url}`);
  });
});
