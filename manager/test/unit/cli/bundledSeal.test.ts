/**
 * The laptop side of a manager deploy: one command turns the checked out
 * streaming stack into a sealed package the host can verify byte for byte.
 *
 * Unit test over a real throwaway git checkout, because the command exports
 * the git objects of HEAD rather than copying the working tree. `pnpm test`
 * in manager/.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUNDLED_SEAL_USAGE, runBundledSeal } from '../../../src/cli/bundledSeal.js';
import { CONFIG_REVISION_FILE, readHostConfigRevision } from '../../../src/domain/versions/hostConfigCapture.js';
import { verifyBundledPackage } from '../../../src/domain/versions/bundledShipmentPackage.js';

const SHIPMENT_ID = '3f1c2b64-5a2e-4d7b-8c19-6a0f4d2e8b71';
const TOOLCHAIN = 'node v22.9.0 pnpm 9.0.0 Darwin/arm64';
const DIST = 'packages/x/dist';
const SECOND_DIST = 'packages/y/dist';
const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const INPUT_MODE = 0o600;
const MANAGER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMMAND_TIMEOUT_MS = 60_000;
/** A synthetic value, so a test can prove the command never echoes an input file's contents. */
const TOKEN_VALUE = 'synthetic-token-value';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=seal tests', '-c', 'user.email=seal@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

describe('bundled:seal', () => {
  let root: string; let source: string; let out: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-seal-'));
    source = join(root, 'stack'); out = join(root, 'shipment');
    await mkdir(join(source, 'deploy', 'scripts'), { recursive: true });
    await mkdir(join(source, DIST), { recursive: true });
    await mkdir(join(source, SECOND_DIST), { recursive: true });
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, '.gitignore'), ['node_modules/', '.env', 'deploy/config.json', 'packages/*/dist/', CONFIG_REVISION_FILE, ''].join('\n'));
    await writeFile(join(source, 'packages', 'y', 'kept.txt'), 'committed beside the built directory\n');
    await writeFile(join(source, 'deploy', 'scripts', '_lib.sh'), 'readonly PORT_VARS=(\n  "RTMP_PORT:1935:19000"\n)\n');
    await writeFile(join(source, 'deploy', 'docker-compose.yml'), 'services:\n  srs:\n    image: synthetic/srs:fixed\n');
    await writeFile(join(source, '.env.sample'), 'API_AUTH_TOKEN=\nSRT_PASSPHRASE=\n');
    git(source, ['init', '--quiet', '--initial-branch=main']);
    git(source, ['add', '--all']);
    git(source, ['commit', '--quiet', '--message', 'the checked out stack']);
    await writeFile(join(source, '.env'), `API_AUTH_TOKEN=${TOKEN_VALUE}\nSRT_PASSPHRASE=synthetic-passphrase\n`);
    await writeFile(join(source, 'deploy', 'config.json'), '{}\n');
    await writeFile(join(source, DIST, 'app.js'), 'export const built = true;\n');
    await writeFile(join(source, DIST, 'tool.sh'), '#!/bin/sh\necho built\n');
    await chmod(join(source, DIST, 'tool.sh'), EXECUTABLE_MODE);
    await writeFile(join(source, SECOND_DIST, 'uploader.js'), 'export const uploads = true;\n');
    await writeFile(join(source, 'node_modules', 'installed.js'), 'module.exports = {};\n');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function seal(options: { dist?: readonly string[]; out?: string; adoptInputs?: boolean; toolchain?: string } = {}): Promise<{ stdout: string[]; stderr: string[] }> {
    const stdout: string[] = []; const stderr: string[] = [];
    await runBundledSeal(
      ['--source', source, '--out', options.out ?? out, '--shipment-id', SHIPMENT_ID,
        ...(options.dist ?? [DIST, SECOND_DIST]).flatMap((dist) => ['--dist', dist]),
        '--toolchain', options.toolchain ?? TOOLCHAIN, ...(options.adoptInputs === false ? [] : ['--adopt-inputs'])],
      { out: (line) => stdout.push(line), err: (line) => stderr.push(line) },
    );
    return { stdout, stderr };
  }

  it('seals a package the host verifies, carrying the built files and the host inputs and no installed packages', async () => {
    const { stdout } = await seal();

    const { path, ...identity } = JSON.parse(stdout[0]!) as { shipmentId: string; commit: string; digest: string; path: string };
    const sealed = join(out, `sealed-${SHIPMENT_ID}`);
    assert.equal(path, sealed);
    const verified = await verifyBundledPackage(sealed, identity);
    assert.equal(verified.manifest.commit, identity.commit);
    assert.equal(await readFile(join(sealed, DIST, 'app.js'), 'utf8'), 'export const built = true;\n');
    assert.equal(await readFile(join(sealed, SECOND_DIST, 'uploader.js'), 'utf8'), 'export const uploads = true;\n');
    assert.equal(await readFile(join(sealed, 'packages', 'y', 'kept.txt'), 'utf8'), 'committed beside the built directory\n');
    assert.equal(await readFile(join(sealed, 'deploy', 'config.json'), 'utf8'), '{}\n');
    assert.match(await readFile(join(sealed, '.env'), 'utf8'), /SRT_PASSPHRASE=/);
    assert.ok(existsSync(join(sealed, CONFIG_REVISION_FILE)), 'the package carries the input revision it was sealed against');
    assert.equal(existsSync(join(sealed, 'node_modules')), false, 'installed packages never enter the package');
    assert.equal(existsSync(join(out, 'export')), false, 'the working tree the seal exported is gone');
  });

  it('prints one line on stdout and it is the identity the deploy passes on', async () => {
    const { stdout } = await seal();

    assert.equal(stdout.length, 1);
    const identity = JSON.parse(stdout[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(identity).sort(), ['commit', 'digest', 'path', 'shipmentId']);
    assert.equal(identity.shipmentId, SHIPMENT_ID);
    assert.match(String(identity.commit), /^[a-f0-9]{40}$/);
    assert.match(String(identity.digest), /^[a-f0-9]{64}$/);
  });

  it('refuses a built directory the checkout does not have, naming it and the command that builds it', async () => {
    await assert.rejects(seal({ dist: ['packages/missing/dist'] }), (error: Error) => {
      assert.match(error.message, /packages\/missing\/dist/);
      assert.match(error.message, /pnpm/);
      return true;
    });
    assert.equal(existsSync(join(out, `sealed-${SHIPMENT_ID}`)), false);
  });

  it('refuses a checkout whose host inputs were never committed, and names the flag that adopts them', async () => {
    await assert.rejects(seal({ adoptInputs: false }), (error: Error) => {
      assert.match(error.message, /--adopt-inputs/);
      return true;
    });
    assert.equal(await readHostConfigRevision(source), null, 'a refusal commits nothing');
  });

  it('adopts the present host inputs as generation one and says which files, never their contents', async () => {
    const { stderr } = await seal();

    const revision = await readHostConfigRevision(source);
    assert.equal(revision?.generation, 1);
    assert.deepEqual(Object.keys(revision?.files ?? {}).sort(), ['.env', 'deploy/config.json']);
    const said = stderr.join('\n');
    assert.match(said, /generation 1/);
    assert.match(said, /\.env/);
    assert.match(said, /deploy\/config\.json/);
    assert.equal(said.includes(TOKEN_VALUE), false, 'an input value never reaches the output');
  });

  it('seals modes the engine containers can read, whatever the umask of the machine it ran on', async () => {
    const before = process.umask(0);
    try {
      await seal();
    } finally {
      process.umask(before);
    }

    const sealed = join(out, `sealed-${SHIPMENT_ID}`);
    const mode = async (path: string) => (await lstat(path)).mode & 0o777;
    assert.equal(await mode(sealed), DIRECTORY_MODE, 'the package root');
    assert.equal(await mode(join(sealed, DIST)), DIRECTORY_MODE, 'a directory inside it');
    assert.equal(await mode(join(sealed, 'deploy', 'docker-compose.yml')), FILE_MODE, 'a plain file');
    assert.equal(await mode(join(sealed, DIST, 'tool.sh')), EXECUTABLE_MODE, 'an executable of a built directory');
    assert.equal(await mode(join(sealed, '.env')), INPUT_MODE, 'and the host inputs stay to their owner');
  });

  it('runs from the command line on a machine with no database, ending on its own', () => {
    // The whole command as a deploy runs it: no DATABASE_URL in the environment, one line on
    // standard output, everything a person reads beside it, and a process that ends by itself.
    const { DATABASE_URL, ...environment } = process.env;
    const run = spawnSync(join(MANAGER_ROOT, 'node_modules', '.bin', 'tsx'), [
      '--conditions=development', join(MANAGER_ROOT, 'src', 'cli.ts'), 'bundled:seal',
      '--source', source, '--out', out, '--shipment-id', SHIPMENT_ID,
      '--dist', DIST, '--dist', SECOND_DIST, '--toolchain', TOOLCHAIN, '--adopt-inputs',
    ], { encoding: 'utf8', env: environment, timeout: COMMAND_TIMEOUT_MS });

    assert.equal(run.error, undefined, 'the command ended without being killed');
    assert.equal(run.status, 0, run.stderr);
    const printed = run.stdout.split('\n').filter(Boolean);
    assert.equal(printed.length, 1, `standard output carries one line only, got: ${run.stdout}`);
    assert.equal(JSON.parse(printed[0]!).shipmentId, SHIPMENT_ID);
    assert.match(run.stderr, /adopted the host inputs/, 'what a person reads went beside it');
  });

  it('answers a missing option with what the command takes', async () => {
    const stderr: string[] = [];
    await assert.rejects(
      runBundledSeal(['--source', source], { out: () => {}, err: (line) => stderr.push(line) }),
      (error: Error) => {
        assert.match(error.message, /--out/);
        assert.ok(error.message.includes(BUNDLED_SEAL_USAGE), 'the usage of this command comes with the refusal');
        return true;
      },
    );
  });

  for (const [shape, toolchain] of [
    ['a quote', "node v22.9.0' rm -rf /"],
    ['a semicolon', 'node v22.9.0; rm -rf /'],
    ['a control character', 'node v22.9.0\nrm -rf /'],
    ['nothing but spaces', '   '],
  ] as const) {
    it(`refuses a toolchain carrying ${shape}, which the deploy would put in a host shell`, async () => {
      await assert.rejects(seal({ toolchain }), (error: Error) => {
        assert.match(error.message, /--toolchain/);
        return true;
      });
      assert.equal(existsSync(join(out, `sealed-${SHIPMENT_ID}`)), false, 'nothing was sealed under it');
    });
  }

  it('refuses an output directory inside the checkout it seals', async () => {
    await assert.rejects(seal({ out: join(source, 'shipment') }), (error: Error) => {
      assert.match(error.message, /--out/);
      return true;
    });
  });
});
