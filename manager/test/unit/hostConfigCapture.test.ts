/**
 * How the host-owned inputs of a version are captured for a build: one
 * committed revision or a refusal, never a mix.
 *
 * Unit test over a temporary directory. `pnpm test` in manager/.
 *
 * The base env, the deploy config and the engine envs are the operator's.
 * The supported way to change them commits them as a set: a lock around the
 * whole edit, each file replaced atomically, and a revision manifest with a
 * generation and every file's hash written last. Capture takes the same lock,
 * reads the manifest, reads every file it lists and refuses on any mismatch
 * naming the file. Two atomic single-file replacements with a pause between
 * them would otherwise give capture a valid new first file and a valid old
 * second one, and no per-file check can tell.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  adoptHostConfig,
  captureHostConfig,
  commitHostConfig,
  CONFIG_LOCK_DIR,
  CONFIG_REVISION_FILE,
  holdHostConfigLock,
} from '../../src/domain/versions/hostConfigCapture.js';

const SAMPLE_KEYS = ['ENGINE', 'API_PORT'];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A version root with a committed revision of two files. */
function root(over: { env?: string; config?: string; generation?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-config-'));
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  const env = over.env ?? 'ENGINE=srs\nAPI_PORT=3000\n';
  const config = over.config ?? '{"revision":"A"}\n';
  writeFileSync(join(dir, '.env'), env);
  writeFileSync(join(dir, 'deploy', 'config.json'), config);
  writeFileSync(
    join(dir, CONFIG_REVISION_FILE),
    JSON.stringify({ generation: over.generation ?? 3, files: { '.env': sha(env), 'deploy/config.json': sha(config) } }),
  );
  return dir;
}

const QUICK = { sampleEnvKeys: SAMPLE_KEYS, lockWaitMs: 60 };

describe('captureHostConfig', () => {
  it('captures the committed revision: the bytes, their hashes and the generation', async () => {
    const dir = root();

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.problem, null);
    assert.equal(result.captured?.generation, 3);
    assert.equal(result.captured?.files.get('.env')?.toString('utf8'), 'ENGINE=srs\nAPI_PORT=3000\n');
    assert.equal(result.captured?.hashes['deploy/config.json'], sha('{"revision":"A"}\n'));
    assert.equal(existsSync(join(dir, CONFIG_LOCK_DIR)), false, 'the lock is released');
  });

  it('refuses a file whose bytes do not match the manifest, naming it', async () => {
    const dir = root();
    writeFileSync(join(dir, 'deploy', 'config.json'), '{"revision":"B"}\n');

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /deploy\/config\.json/);
    assert.match(result.problem ?? '', /does not match/);
  });

  it('refuses a truncated file the same way, because its hash is not the committed one', async () => {
    const dir = root();
    writeFileSync(join(dir, '.env'), '');

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /\.env/);
  });

  it('refuses a file of the set the manifest does not list', async () => {
    const dir = root();
    mkdirSync(join(dir, 'engines', 'srs'), { recursive: true });
    writeFileSync(join(dir, 'engines', 'srs', '.env'), 'SRS_X=1\n');

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /engines\/srs\/\.env/);
    assert.match(result.problem ?? '', /not in the committed revision/);
  });

  it('refuses a base env that lacks a key the version samples, even when committed', async () => {
    const env = 'ENGINE=srs\n';
    const dir = root({ env });

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /API_PORT/);
  });

  it('refuses a deploy config that does not parse, even when committed', async () => {
    const dir = root({ config: '{ not json' });

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /config\.json/);
    assert.match(result.problem ?? '', /parse/);
  });

  it('refuses a root without a manifest, saying how to commit one', async () => {
    const dir = root();
    rmSync(join(dir, CONFIG_REVISION_FILE));

    const result = await captureHostConfig(dir, QUICK);

    assert.equal(result.captured, null);
    assert.match(result.problem ?? '', /no committed revision/);
  });

  it('waits for an edit under way, bounded, then refuses rather than reading a mix', async () => {
    const dir = root();
    // An editor that replaced the first file and paused before the second.
    const release = await holdHostConfigLock(dir);
    writeFileSync(join(dir, '.env'), 'ENGINE=srs\nAPI_PORT=4000\n');

    const during = await captureHostConfig(dir, QUICK);
    assert.equal(during.captured, null);
    assert.match(during.problem ?? '', /being edited/);

    // The editor finishes: the second file and the manifest land, the lock goes.
    writeFileSync(join(dir, 'deploy', 'config.json'), '{"revision":"B"}\n');
    writeFileSync(
      join(dir, CONFIG_REVISION_FILE),
      JSON.stringify({ generation: 4, files: { '.env': sha('ENGINE=srs\nAPI_PORT=4000\n'), 'deploy/config.json': sha('{"revision":"B"}\n') } }),
    );
    await release();

    const after = await captureHostConfig(dir, QUICK);
    assert.equal(after.problem, null);
    assert.equal(after.captured?.generation, 4);
    assert.equal(after.captured?.files.get('.env')?.toString('utf8'), 'ENGINE=srs\nAPI_PORT=4000\n');
    assert.equal(after.captured?.files.get('deploy/config.json')?.toString('utf8'), '{"revision":"B"}\n');
  });
});

describe('commitHostConfig', () => {
  it('replaces the files and writes the manifest last, one generation up', async () => {
    const dir = root();

    const revision = await commitHostConfig(dir, {
      '.env': Buffer.from('ENGINE=ome\nAPI_PORT=3000\n'),
      'deploy/config.json': Buffer.from('{"revision":"B"}\n'),
    });

    assert.equal(revision.generation, 4);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'ENGINE=ome\nAPI_PORT=3000\n');
    const manifest = JSON.parse(readFileSync(join(dir, CONFIG_REVISION_FILE), 'utf8'));
    assert.equal(manifest.generation, 4);
    assert.equal(manifest.files['deploy/config.json'], sha('{"revision":"B"}\n'));
    assert.equal(existsSync(join(dir, CONFIG_LOCK_DIR)), false);
  });

  it('removes the files a commit names for removal, and the revision no longer lists them', async () => {
    const dir = root();
    mkdirSync(join(dir, 'engines', 'ome'), { recursive: true });
    writeFileSync(join(dir, 'engines', 'ome', '.env'), 'OME_LOG=debug\n');
    await commitHostConfig(dir, { 'engines/ome/.env': Buffer.from('OME_LOG=info\n') });

    const revision = await commitHostConfig(dir, {}, { remove: ['engines/ome/.env'] });

    assert.equal(existsSync(join(dir, 'engines', 'ome', '.env')), false);
    assert.equal('engines/ome/.env' in revision.files, false);
    assert.equal(revision.generation, 3);
  });

  it('refuses while an edit is under way, and changes nothing', async () => {
    const dir = root();
    const release = await holdHostConfigLock(dir);

    await assert.rejects(
      commitHostConfig(dir, { '.env': Buffer.from('ENGINE=ome\nAPI_PORT=3000\n') }, { lockWaitMs: 60 }),
      /being edited/,
    );
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'ENGINE=srs\nAPI_PORT=3000\n');
    await release();
  });
});

describe('adoptHostConfig', () => {
  it('gives a root without a manifest generation 1 from its current bytes, and leaves a committed one alone', async () => {
    const fresh = root();
    rmSync(join(fresh, CONFIG_REVISION_FILE));

    const adopted = await adoptHostConfig(fresh);
    assert.equal(adopted?.generation, 1);
    assert.equal(JSON.parse(readFileSync(join(fresh, CONFIG_REVISION_FILE), 'utf8')).files['.env'], sha('ENGINE=srs\nAPI_PORT=3000\n'));

    const committed = root({ generation: 7 });
    assert.equal(await adoptHostConfig(committed), null);
    assert.equal(JSON.parse(readFileSync(join(committed, CONFIG_REVISION_FILE), 'utf8')).generation, 7);
  });
});
