/**
 * BEE_*_DATA_DIR describes a directory on the manager's own host, so it must
 * only be exported for a deploy that lands there.
 *
 * Unit test, no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Exporting it for a remote target silently broke every remote Bee node. The
 * value is process env for deploy.sh and never crosses the ssh boundary, so
 * `init_bee_dirs` wrote the password under $REMOTE_BASE/deploy/<absolute
 * manager path>/ while the remote compose, reading the rsynced .env, mounted
 * $REMOTE_BASE/deploy/data/bee-uploader. Bee found an empty data dir and died
 * on "configure signer: open /home/bee/.bee/password: no such file or
 * directory", on a loop, on every rung of every ABR pool deployed off-host.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeDataDirsFor } from '../../src/domain/dataDirs.js';

describe('beeDataDirsFor', () => {
  it('names both data dirs for a localhost deploy', () => {
    const dirs = beeDataDirsFor('stage1-abr-360p', 'localhost');
    assert.deepEqual(Object.keys(dirs).sort(), [
      'BEE_GATEWAY_DATA_DIR',
      'BEE_UPLOADER_DATA_DIR',
    ]);
    assert.match(dirs.BEE_UPLOADER_DATA_DIR!, /\/stage1-abr-360p\/bee-uploader$/);
    assert.match(dirs.BEE_GATEWAY_DATA_DIR!, /\/stage1-abr-360p\/bee-gateway$/);
  });

  it('gives each profile its own directory', () => {
    const a = beeDataDirsFor('stage1-abr-360p', 'localhost');
    const b = beeDataDirsFor('stage1-abr-720p', 'localhost');
    assert.notEqual(a.BEE_UPLOADER_DATA_DIR, b.BEE_UPLOADER_DATA_DIR);
  });

  // The regression. An absolute manager-side path reaching deploy.sh for a
  // remote target is what put init_bee_dirs and compose on different dirs.
  it('says nothing for a remote deploy', () => {
    assert.deepEqual(beeDataDirsFor('stage1-abr-360p', 'solarpunk@108.61.171.132'), {});
    assert.deepEqual(beeDataDirsFor('stage1-abr-360p', 'vultr-eu-1'), {});
  });

  it('says nothing for a loopback literal, which deploy.sh treats as a remote target', () => {
    // Only 'localhost' is local to the stack's is_local, and 127.0.0.1 goes
    // down the ssh/rsync path, so compose there reads the rsynced .env, not
    // this env.
    assert.deepEqual(beeDataDirsFor('stage1-abr-360p', '127.0.0.1'), {});
  });

  it('treats an empty target as local — targetAlias maps null and \'\' to localhost before this is reached', () => {
    const dirs = beeDataDirsFor('stage1-abr-360p', '');
    assert.equal(Object.keys(dirs).length, 2);
  });
});
