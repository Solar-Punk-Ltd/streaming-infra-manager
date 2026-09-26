/**
 * The environment a deployment's containers get, as the manager works it out
 * without asking Docker.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Compose reads the deployment's env file, and `deploy.sh` has the last word on
 * a few keys: it shifts every port of the version's table by the slot, it
 * passes the feed and the stamp as arguments, and the manager exports the data
 * directories on its own host, which beats any line of the file. The engine's
 * own env file fills in what the root file leaves out. A record that got any of
 * these wrong would report drift that is not there, or miss drift that is.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeProfile } from '../support/profileFixtures.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const { effectiveEnvOf } = await import('../../src/domain/settings/effectiveEnv.js');
const { BEE_DATA_ROOT } = await import('../../src/domain/dataDirs.js');

const REMOTE = 'remote-host';
const LOCAL = 'localhost';

function effective(over: { root?: string; engine?: string; slot?: number; target?: string; profile?: object } = {}) {
  return effectiveEnvOf({
    profile: makeProfile({ name: 'stage', port_slot: over.slot ?? 3, ...(over.profile ?? {}) }),
    contract: ALLOCATION_CONTRACT,
    target: over.target ?? REMOTE,
    rootEnvText: over.root ?? '',
    engineEnvText: over.engine ?? '',
  });
}

describe('the environment a deployment gets', () => {
  it('takes a key from the engine env file where the root file leaves it out, and lets the root file win', () => {
    const env = effective({ root: 'HLS_WINDOW=30\n', engine: 'HLS_WINDOW=10\nSRS_WEBHOOK_TOKEN=abc\n' });

    assert.equal(env.HLS_WINDOW, '30');
    assert.equal(env.SRS_WEBHOOK_TOKEN, 'abc');
  });

  it("gives every port of the version's table the slot's number, and the adapters the API port", () => {
    const env = effective({ root: 'API_PORT=10000\nSRS_ADAPTER_PORT=1\n', slot: 3 });

    assert.equal(env.API_PORT, '10030');
    assert.equal(env.SRS_ADAPTER_PORT, '10030');
    assert.equal(env.OME_ADAPTER_PORT, '10030');
  });

  it("gives the feed and the stamp the deployment's own values, which deploy.sh passes as arguments", () => {
    const env = effective({
      root: 'STAMP=\nSTREAM_LIST_TOPIC=other\nVITE_APP_OWNER=other\n',
      profile: { stamp_id: `0x${'a'.repeat(64)}`, feed_topic: 'stage-topic', feed_owner: `0x${'b'.repeat(40)}` },
    });

    assert.equal(env.STAMP, 'a'.repeat(64));
    assert.equal(env.STREAM_LIST_TOPIC, 'stage-topic');
    assert.equal(env.VITE_APP_RAW_TOPIC, 'stage-topic');
    assert.equal(env.VITE_APP_OWNER, 'b'.repeat(40));
  });

  it("gives the data directories the manager's own paths on its own host only", () => {
    const local = effective({ root: 'BEE_UPLOADER_DATA_DIR=./data/bee-uploader\n', target: LOCAL });
    const remote = effective({ root: 'BEE_UPLOADER_DATA_DIR=./data/bee-uploader\n', target: REMOTE });

    assert.equal(local.BEE_UPLOADER_DATA_DIR, `${BEE_DATA_ROOT}/stage/bee-uploader`);
    assert.equal(remote.BEE_UPLOADER_DATA_DIR, './data/bee-uploader');
  });

  it('leaves every other key as the file says', () => {
    assert.equal(effective({ root: 'LOG_LEVEL=debug\nUPLOADER_START_GATES="warn"\n' }).UPLOADER_START_GATES, 'warn');
  });
});
