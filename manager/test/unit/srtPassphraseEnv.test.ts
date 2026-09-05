/**
 * How an SRT passphrase reaches the SRS container.
 *
 * Unit test — no database, no Docker. `pnpm test` in manager/.
 *
 * Two behaviours are worth pinning here rather than trusting to review:
 *
 *  - The fallback. `writeProfileEnv` copies the whole base .env and upserts the
 *    per-profile keys over it, so a profile with no passphrase of its own must
 *    leave the host-wide SRT_PASSPHRASE standing. That is how every deployment
 *    behaved before the column existed, and clearing the field returns to it.
 *  - The refusal. `engines/srs/entrypoint.sh` splices this value into srs.conf
 *    through `sed "s/PASSPHRASE_PLACEHOLDER/$SRT_PASSPHRASE/"` with no guard of
 *    its own, so a `/` writes a corrupt config and the container crash-loops
 *    under `restart: unless-stopped`. The request schema and a CHECK constraint
 *    refuse it earlier; this is the last gate, and it must not be silently lost
 *    if someone loosens one of those.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// SUBMODULE resolves from SHLS_ROOT at module load, so the env var has to be set
// before envUtils is imported — hence the dynamic import in `before`.
const root = mkdtempSync(join(tmpdir(), 'srt-passphrase-'));
const previousRoot = process.env.SHLS_ROOT;

let writeProfileEnv: typeof import('../../src/utils/envUtils.js').writeProfileEnv;

before(async () => {
  process.env.SHLS_ROOT = root;
  ({ writeProfileEnv } = await import('../../src/utils/envUtils.js'));
});

after(() => {
  if (previousRoot === undefined) delete process.env.SHLS_ROOT;
  else process.env.SHLS_ROOT = previousRoot;
});

function withBaseEnv(contents: string): void {
  writeFileSync(join(root, '.env'), contents, 'utf8');
}

function envFor(name: string, srtPassphrase?: string | null): string {
  return readFileSync(
    writeProfileEnv(name, { engine: 'srs', srtPassphrase }),
    'utf8',
  );
}

describe('writeProfileEnv — SRT_PASSPHRASE', () => {
  it('writes the profile passphrase over the host-wide one', () => {
    withBaseEnv('SRT_PASSPHRASE=host-wide-secret\nAPI_PORT=10000\n');
    const env = envFor('over', 'profile-own-secret');

    assert.match(env, /^SRT_PASSPHRASE=profile-own-secret$/m);
    assert.doesNotMatch(env, /host-wide-secret/);
    // Upsert, not append: exactly one line for the key.
    assert.equal(env.match(/^SRT_PASSPHRASE=/gm)?.length, 1);
    assert.match(env, /^API_PORT=10000$/m, 'the rest of .env must survive');
  });

  it('leaves the host-wide passphrase standing when the profile sets none', () => {
    withBaseEnv('SRT_PASSPHRASE=host-wide-secret\n');

    for (const unset of [undefined, null, '', '   ']) {
      assert.match(
        envFor('unset', unset),
        /^SRT_PASSPHRASE=host-wide-secret$/m,
        `${JSON.stringify(unset)} should fall back to the base .env`,
      );
    }
  });

  it('adds the key to a base .env that has none', () => {
    withBaseEnv('API_PORT=10000\n');
    assert.match(
      envFor('added', 'added-secret'),
      /^SRT_PASSPHRASE=added-secret$/m,
    );
  });

  it('refuses a passphrase that would corrupt the sed in entrypoint.sh', () => {
    withBaseEnv('SRT_PASSPHRASE=host-wide-secret\n');

    const bads = ['pass/phrase1', 'pass&phrase1', 'short', 'a'.repeat(80)];
    for (const bad of bads) {
      assert.throws(
        () => envFor('bad', bad),
        /refusing to write SRT_PASSPHRASE/,
        `should refuse ${bad}`,
      );
    }
  });
});
