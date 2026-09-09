/**
 * What a build does about settings a newer version of the stack declares and
 * the host's own files do not have yet.
 *
 * Until now publication refused: the base env lacked a key the version's
 * `.env.sample` declares, and the operator had to add it by hand with the
 * editing script before the version could be built. A version the manager
 * itself pins has nobody to do that, so the missing keys are appended from the
 * sample instead, as a new revision under the same lock the editor uses. The
 * operator's own lines are never touched, and a value the sample leaves blank
 * stays blank, so a setting that has to be filled in is still visibly empty.
 *
 * Unit test over a scratch directory. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  commitHostConfig,
  CONFIG_REVISION_FILE,
  readHostConfigRevision,
} from '../../src/domain/versions/hostConfigCapture.js';
import { completeHostConfigFromSamples } from '../../src/domain/versions/hostConfigCompletion.js';

const SAMPLE = [
  '# The keys this version declares.',
  'STAMP=',
  'STREAM_KEY=',
  'CHEQUEBOOK_MIN_BZZ=0.5',
  '# HLS_FRAGMENT=0.5',
  'API_PORT=3000',
  '',
].join('\n');

let root: string;
let configRoot: string;
let staging: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-config-completion-'));
  configRoot = join(root, 'config');
  staging = join(root, 'staging');
  mkdirSync(configRoot);
  mkdirSync(staging);
  writeFileSync(join(staging, '.env.sample'), SAMPLE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The base env as a committed revision, the way an operator's edit leaves one. */
async function committedEnv(text: string): Promise<void> {
  await commitHostConfig(configRoot, { '.env': Buffer.from(text, 'utf8') });
}

function baseEnv(): string {
  return readFileSync(join(configRoot, '.env'), 'utf8');
}

describe("completing a base env from the version's sample", () => {
  it('appends the sample lines for the keys it lacks, in the sample order, and leaves its own lines alone', async () => {
    await committedEnv('STAMP=paid-for\nAPI_PORT=3000\n');

    await completeHostConfigFromSamples(configRoot, staging);

    assert.equal(baseEnv(), 'STAMP=paid-for\nAPI_PORT=3000\nSTREAM_KEY=\nCHEQUEBOOK_MIN_BZZ=0.5\n');
  });

  it('answers which keys it added to which file', async () => {
    await committedEnv('STAMP=paid-for\nAPI_PORT=3000\n');

    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, { '.env': ['STREAM_KEY', 'CHEQUEBOOK_MIN_BZZ'] });
  });

  it('commits what it added as one new revision, so the build captures it', async () => {
    await committedEnv('STAMP=paid-for\n');

    await completeHostConfigFromSamples(configRoot, staging);

    const revision = await readHostConfigRevision(configRoot);
    assert.equal(revision?.generation, 2, 'one generation on from the operator edit');
    assert.ok(revision?.files['.env'], 'the base env is in it');
  });

  it('leaves a file that already has every key of the sample as it stands', async () => {
    await committedEnv('STAMP=a\nSTREAM_KEY=b\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000\n');
    const before = readFileSync(join(configRoot, CONFIG_REVISION_FILE), 'utf8');

    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, {});
    assert.equal(readFileSync(join(configRoot, CONFIG_REVISION_FILE), 'utf8'), before, 'no new revision');
  });

  it('keeps the last line whole when the file does not end with a newline', async () => {
    await committedEnv('STAMP=paid-for\nSTREAM_KEY=k\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000');

    await completeHostConfigFromSamples(configRoot, staging);

    assert.equal(baseEnv(), 'STAMP=paid-for\nSTREAM_KEY=k\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000');
  });

  it('separates its lines from a last line the file left unterminated', async () => {
    await committedEnv('STAMP=paid-for\nAPI_PORT=3000');

    await completeHostConfigFromSamples(configRoot, staging);

    assert.equal(baseEnv(), 'STAMP=paid-for\nAPI_PORT=3000\nSTREAM_KEY=\nCHEQUEBOOK_MIN_BZZ=0.5\n');
  });

  it('takes no key from a line the sample has commented out', async () => {
    await committedEnv('STAMP=a\nSTREAM_KEY=b\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000\n');

    await completeHostConfigFromSamples(configRoot, staging);

    assert.equal(baseEnv().includes('HLS_FRAGMENT'), false, 'a commented sample line is the entrypoint default, not a setting');
  });

  it('writes nothing when the version ships no sample at all', async () => {
    rmSync(join(staging, '.env.sample'));
    await committedEnv('STAMP=a\n');

    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, {});
    assert.equal(baseEnv(), 'STAMP=a\n');
  });

  it('writes nothing when the host has no base env of its own yet', async () => {
    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, {});
    assert.equal(existsSync(join(configRoot, '.env')), false);
  });
});

describe('completing an engine env from the engine sample', () => {
  beforeEach(() => {
    mkdirSync(join(staging, 'engines', 'srs'), { recursive: true });
    writeFileSync(join(staging, 'engines', 'srs', '.env.sample'), 'SRS_API_PORT=1985\nSRS_LOG_LEVEL=trace\n');
  });

  it('completes it against the sample the version ships for that engine', async () => {
    await commitHostConfig(configRoot, {
      '.env': Buffer.from('STAMP=a\nSTREAM_KEY=b\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000\n', 'utf8'),
      'engines/srs/.env': Buffer.from('SRS_API_PORT=1985\n', 'utf8'),
    });

    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, { 'engines/srs/.env': ['SRS_LOG_LEVEL'] });
    assert.equal(readFileSync(join(configRoot, 'engines', 'srs', '.env'), 'utf8'), 'SRS_API_PORT=1985\nSRS_LOG_LEVEL=trace\n');
  });

  it('leaves an engine the host keeps no env for alone, because the deploy makes that file', async () => {
    await commitHostConfig(configRoot, {
      '.env': Buffer.from('STAMP=a\nSTREAM_KEY=b\nCHEQUEBOOK_MIN_BZZ=1\nAPI_PORT=3000\n', 'utf8'),
    });

    const added = await completeHostConfigFromSamples(configRoot, staging);

    assert.deepEqual(added, {});
    assert.equal(existsSync(join(configRoot, 'engines', 'srs', '.env')), false);
  });
});
