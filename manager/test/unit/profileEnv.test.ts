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

  it('normalises a value that was stored before the schema canonicalised it', () => {
    // writeProfileEnv normalises as well as the schema, for rows written
    // before the transform existed. Without it a four-line value already in
    // the database would still produce an .env file compose refuses to read.
    const path = writeProfileEnv('stage-legacy', {
      engine: 'srs',
      beePublishers: PUBLISHERS.split(' ').join('\n'),
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
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

describe('writeProfileEnv — LOCAL_BEE_UPLOADER', () => {
  // deploy.sh's resolve_bee_url computes the local Bee address and writes it
  // into an override file that outranks .env.<profile>. It has to know whether
  // this PROFILE runs a Bee node, and it cannot work that out for itself: the
  // service filter says what the current invocation was asked for, and the
  // manager deploys a held-back uploader on its own once a batch is bought —
  // which looks exactly like a profile that owns no node.
  //
  // Getting it wrong breaks one case or the other. Guarding on the filter left
  // a staged `deploy.sh --profile=x stream-uploader` with the base env's
  // BEE_URL (http://localhost:1663 — inside the container, the container
  // itself), so the uploader crash-looped beside its own healthy Bee node.

  it('says false when the profile runs no Bee node of its own', () => {
    const path = writeProfileEnv('nolocal', {
      engine: 'srs',
      localBeeUploader: false,
      beeUrl: 'http://10.0.0.7:1633',
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=false');
    // And the operator's external node is what is written.
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://10.0.0.7:1633');
  });

  it('says true when it does, so the local address is still resolved', () => {
    // The staged case: only stream-uploader is being deployed, but the profile
    // owns a bee-uploader, so resolve_bee_url must still run.
    const path = writeProfileEnv('withlocal', {
      engine: 'srs',
      localBeeUploader: true,
      stampId: BATCH('360p'),
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=true');
  });

  it('is stated explicitly, not left to the base env', () => {
    // .env.<profile> is a fresh copy of the base .env every deploy, so an
    // absent key would let a base-env value decide it.
    writeBaseEnv('ENGINE=srs\nLOCAL_BEE_UPLOADER=true\n');
    const path = writeProfileEnv('override', {
      engine: 'srs',
      localBeeUploader: false,
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=false');
  });

  it('is omitted when the caller does not say, so deploy.sh decides as before', () => {
    // Absent means "decide as before" in deploy.sh, which keeps a hand-run
    // deploy.sh and an older manager working.
    const path = writeProfileEnv('unsaid', { engine: 'srs' });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), undefined);
  });
});
