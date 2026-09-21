/**
 * What the stack's own scripts are handed as their environment.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The manager runs in a container whose environment names the same things the
 * stack does. `load_env_file` in `_lib.sh` treats the deployment's env file as
 * defaults and lets an already exported variable win, and docker compose
 * prefers a shell variable over an --env-file value, so every collision is the
 * manager's value quietly deciding what the deployment runs with. LOG_LEVEL and
 * BEE_DATA_ROOT are two live ones, and the database credentials reach a script
 * that has no use for them at all.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ScriptRunner } from '../../src/domain/ScriptRunner.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('script-env-');

mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(
  join(root, '.env.sample'),
  '# The stack reads its own LOG_LEVEL\nLOG_LEVEL=info\nAPI_PORT=10000\n# ENGINE=srs\n',
  'utf8',
);
writeFileSync(
  join(root, 'engines', 'srs', '.env.sample'),
  'SRT_PASSPHRASE=\n',
  'utf8',
);

const PRINT_ENV = join(root, 'print-env.sh');
writeFileSync(PRINT_ENV, 'env\n', 'utf8');
const PRINT_SECRET = join(root, 'print-secret.sh');
writeFileSync(
  PRINT_SECRET,
  [
    "node <<'NODE'",
    "const token = process.env.TOKEN_PART_A + process.env.TOKEN_PART_B;",
    "const values = [token, JSON.stringify({ token })];",
    'const delay = () => new Promise(resolve => setTimeout(resolve, 25));',
    '(async () => {',
    '  for (const stream of [process.stdout, process.stderr]) {',
    '    for (const value of values) {',
    '      const splitAt = Math.floor(value.length / 2);',
    '      stream.write(value.slice(0, splitAt));',
    '      await delay();',
    '      stream.write(value.slice(splitAt));',
    '    }',
    '  }',
    '})().catch(error => {',
    '  process.stderr.write(String(error));',
    '  process.exitCode = 1;',
    '});',
    'NODE',
  ].join('\n'),
  'utf8',
);

const PARENT = {
  DATABASE_URL: 'postgres://manager@localhost/manager',
  POSTGRES_PASSWORD: 'not-the-stack-s',
  BEE_DATA_ROOT: '/home/solarpunk/streaming-infra-manager-data',
  LOG_LEVEL: 'debug',
  API_PORT: '19999',
  SRT_PASSPHRASE: 'the-manager-s-own',
  MANAGER_PORT: '9876',
  ADMIN_API_TOKEN: 'synthetic-admin-token-at-least-32-bytes',
};

/** The environment the script actually saw, by key. */
async function childEnv(
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Map<string, string>> {
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(PARENT)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const handle = new ScriptRunner().run(PRINT_ENV, [], options);
    let out = '';
    handle.emitter.on('stdout', (chunk: string) => {
      out += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      handle.emitter.on('done', () => resolve());
      handle.emitter.on('error', reject);
    });
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) seen.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return seen;
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('the environment a stack script is run with', () => {
  it('drops the names that must never reach a child', async () => {
    const env = await childEnv({ cwd: root });

    assert.equal(env.has('DATABASE_URL'), false);
    assert.equal(env.has('POSTGRES_PASSWORD'), false);
    assert.equal(env.has('BEE_DATA_ROOT'), false);
    assert.equal(env.has('LOG_LEVEL'), false);
    assert.equal(env.has('ADMIN_API_TOKEN'), false);
  });

  it('drops a key the deployment stack declares, and keeps one it does not', async () => {
    const env = await childEnv({ cwd: root });

    assert.equal(env.has('API_PORT'), false, 'declared in the root sample');
    assert.equal(env.has('SRT_PASSPHRASE'), false, 'declared in the srs sample');
    assert.equal(env.get('MANAGER_PORT'), '9876', 'the stack declares nothing of the sort');
  });

  it('keeps what a script needs from the machine it runs on', async () => {
    const env = await childEnv({ cwd: root });

    assert.ok(env.get('PATH'), 'a script with no PATH finds no docker');
    assert.ok(env.get('HOME'), 'docker and git both read it');
  });

  it('lets what the manager sets on purpose through, stripped name or not', async () => {
    const env = await childEnv({
      cwd: root,
      env: {
        BEE_UPLOADER_DATA_DIR: '/data/plain/bee-uploader',
        API_PORT: '10040',
        ADMIN_API_TOKEN: 'intended-managed-consumer-token',
      },
    });

    assert.equal(env.get('BEE_UPLOADER_DATA_DIR'), '/data/plain/bee-uploader');
    assert.equal(env.get('API_PORT'), '10040');
    assert.equal(env.get('ADMIN_API_TOKEN'), 'intended-managed-consumer-token');
  });

  it('still drops the fixed names for a script run outside any stack', async () => {
    // The stack version build script is run from no root of its own, so there
    // are no samples to read and the fixed list is the whole of the strip.
    const env = await childEnv();

    assert.equal(env.has('DATABASE_URL'), false);
    assert.equal(env.has('LOG_LEVEL'), false);
    assert.equal(env.has('ADMIN_API_TOKEN'), false);
    assert.equal(env.get('API_PORT'), '19999', 'no sample says this is the stack\'s');
  });

  it('withholds raw and JSON-escaped child output for a token-bearing process', async () => {
    const token = 'managed-"srs\\fixture-token-at-least-32-bytes';
    const splitAt = 17;
    const handle = new ScriptRunner().run(PRINT_SECRET, [], {
      cwd: root,
      env: {
        TOKEN_PART_A: token.slice(0, splitAt),
        TOKEN_PART_B: token.slice(splitAt),
      },
      withholdOutput: true,
    });
    let stdout = '';
    let stderr = '';
    let outcome: { code: number; signal: NodeJS.Signals | null } | undefined;
    handle.emitter.on('stdout', (chunk: string) => {
      stdout += chunk;
    });
    handle.emitter.on('stderr', (chunk: string) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      handle.emitter.on('done', (result) => {
        outcome = result;
        resolve();
      });
      handle.emitter.on('error', reject);
    });

    assert.match(stdout, /^\[ScriptRunner\] stdout withheld \(\d+ bytes\)\n$/);
    assert.match(stderr, /^\[ScriptRunner\] stderr withheld \(\d+ bytes\)\n$/);
    assert.equal((stdout + stderr).includes(token), false);
    assert.equal((stdout + stderr).includes(JSON.stringify({ token })), false);
    assert.deepEqual(outcome, { code: 0, signal: null });
  });
});
