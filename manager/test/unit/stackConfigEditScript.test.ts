/**
 * That the operator's editing script commits a revision the way capture
 * expects one: the same lock, atomic replacement, the manifest last.
 *
 * Read from the file, as the build script's test reads it: the script runs
 * against a host's real configuration, which no unit test has.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  captureHostConfig,
  CONFIG_EDIT_SCRIPT,
  CONFIG_LOCK_DIR,
  CONFIG_REVISION_FILE,
} from '../../src/domain/versions/hostConfigCapture.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', CONFIG_EDIT_SCRIPT);
const script = readFileSync(SCRIPT, 'utf8');

const edit = (root: string, ...args: string[]): string =>
  execFileSync('bash', [SCRIPT, root, ...args], { encoding: 'utf8' });

describe(CONFIG_EDIT_SCRIPT, () => {
  it('takes the lock capture takes, by the same atomic mkdir, and gives it back on exit', () => {
    assert.match(script, new RegExp(`LOCK_DIR="${CONFIG_LOCK_DIR.replace('.', '\\.')}"`));
    assert.match(script, /mkdir "\$ROOT\/\$LOCK_DIR"/);
    assert.match(script, /trap 'release' EXIT/);
    assert.match(script, /rmdir "\$ROOT\/\$LOCK_DIR"/);
  });

  it('waits a bounded time for an edit under way and then refuses, naming the lock', () => {
    assert.match(script, /LOCK_WAIT_SECONDS/);
    assert.match(script, /is being edited/);
  });

  it('replaces every file by writing beside it and renaming over it', () => {
    assert.match(script, /mv -f "\$target\.tmp\.\$\$" "\$target"/);
  });

  it('writes the manifest last, by rename, with the generation one up and every file hashed', () => {
    assert.match(script, new RegExp(`${CONFIG_REVISION_FILE.replace('.', '\\.')}`));
    assert.match(script, /generation \+ 1|generation=\$\(\(/);
    assert.match(script, /sha256sum|shasum -a 256/);
    const manifestWrite = script.indexOf('write_manifest');
    const lastReplace = script.lastIndexOf('replace_file "$');
    assert.ok(manifestWrite !== -1 && lastReplace !== -1);
  });

  it('offers --unlock for a lock whose editor is gone, and nothing else removes one', () => {
    assert.match(script, /--unlock/);
  });

  it('names only the files of the set: the base env, the deploy config and the engine envs', () => {
    assert.match(script, /\.env\)/);
    assert.match(script, /deploy\/config\.json\)/);
    assert.match(script, /engines\/\*\/\.env|engines\/[^)]*\.env\)/);
  });
});

describe(`${CONFIG_EDIT_SCRIPT} run against a root`, () => {
  it('commits a set the manager captures as that revision, and only files of the set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-edit-'));
    mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
    const sources = mkdtempSync(join(tmpdir(), 'config-edit-sources-'));
    writeFileSync(join(sources, 'env'), 'ENGINE=srs\nAPI_PORT=3000\n');
    writeFileSync(join(sources, 'config'), '{"revision":"B"}\n');
    writeFileSync(join(sources, 'srs-env'), 'SRS_X=1\n');

    const out = edit(
      root,
      'set',
      '.env', join(sources, 'env'),
      'deploy/config.json', join(sources, 'config'),
      'engines/srs/.env', join(sources, 'srs-env'),
    );
    assert.match(out, /Committed revision 1/);
    assert.equal(existsSync(join(root, CONFIG_LOCK_DIR)), false);

    const captured = await captureHostConfig(root, { sampleEnvKeys: ['ENGINE', 'API_PORT'], lockWaitMs: 60 });
    assert.equal(captured.problem, null);
    assert.equal(captured.captured?.generation, 1);
    assert.deepEqual([...(captured.captured?.files.keys() ?? [])].sort(), ['.env', 'deploy/config.json', 'engines/srs/.env']);

    writeFileSync(join(root, '.env'), 'ENGINE=ome\nAPI_PORT=3000\n');
    assert.match(edit(root, 'commit'), /Committed revision 2/);
    const again = await captureHostConfig(root, { sampleEnvKeys: ['ENGINE'], lockWaitMs: 60 });
    assert.equal(again.captured?.generation, 2);
    assert.equal(again.captured?.files.get('.env')?.toString('utf8'), 'ENGINE=ome\nAPI_PORT=3000\n');

    assert.throws(() => edit(root, 'set', 'deploy/secrets.json', join(sources, 'config')), /not a file of the set/);
    assert.throws(() => edit(root, 'set', 'engines/../.env', join(sources, 'env')), /not a file of the set/);
  });

  it('waits on a held lock, refuses, and --unlock frees it', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-edit-'));
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
    mkdirSync(join(root, CONFIG_LOCK_DIR));

    assert.throws(
      () => execFileSync('bash', [SCRIPT, root, 'commit'], { encoding: 'utf8', env: { ...process.env, LOCK_WAIT_SECONDS_OVERRIDE: '0' }, timeout: 40_000 }),
      /is being edited/,
    );
    assert.match(edit(root, '--unlock'), /Removed/);
    assert.match(edit(root, 'commit'), /Committed revision 1/);
  });
});

describe(`${CONFIG_EDIT_SCRIPT} and the modes it leaves behind`, () => {
  // Every file of the set holds secrets, the base env the stream passphrase
  // and the api token among them, and the versions root above them is
  // readable by anyone on the host. The umask is fixed here so the answer is
  // the script's rather than the machine's.
  let umask: number;
  before(() => { umask = process.umask(0o022); });
  after(() => { process.umask(umask); });

  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  const sourceFile = (text: string): string => {
    const source = join(mkdtempSync(join(tmpdir(), 'config-edit-source-')), 'content');
    writeFileSync(source, text);
    return source;
  };

  it('gives a file it creates, and the manifest beside it, the owner only mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-edit-modes-'));

    edit(root, 'set', '.env', sourceFile('ENGINE=srs\n'));

    assert.equal(modeOf(join(root, '.env')), 0o600);
    assert.equal(modeOf(join(root, CONFIG_REVISION_FILE)), 0o600);
  });

  for (const mode of [0o600, 0o640]) {
    it(`keeps the ${mode.toString(8)} an operator gave a file it replaces`, () => {
      const root = mkdtempSync(join(tmpdir(), 'config-edit-modes-'));
      writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
      chmodSync(join(root, '.env'), mode);

      edit(root, 'set', '.env', sourceFile('ENGINE=ome\n'));

      assert.equal(modeOf(join(root, '.env')), mode);
      assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'ENGINE=ome\n');
    });
  }
});
