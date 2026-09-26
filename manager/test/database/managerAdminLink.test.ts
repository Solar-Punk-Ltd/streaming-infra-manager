/**
 * The manager's own web2 admin link, migration 041's single-row table, against
 * a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T11_TEST_PG_PORT set.
 *
 * What only the database can show: that the table holds one row and never a
 * second, that a read never selects the token, that a save lands only at the
 * revision it read, and that the rules the columns carry refuse a token with
 * no address even from a write that skipped the service. And that a new
 * deployment, or every member of a new group, that asks for the stored token
 * gets it in its secret settings inside the insert's own transaction, or is
 * not created at all.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { STANDARD_GROUP_KIND } from '@streaming-infra-manager/common';

import { ManagerAdminLinkRepository } from '../../src/domain/adminLink/ManagerAdminLinkRepository.js';
import { DeploymentGroupRepository, type SharedProfileParams } from '../../src/domain/DeploymentGroupRepository.js';
import { type InitialStackSettings, ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't11_test',
  connectionTimeoutMillis: 10000,
};

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';

describe("the manager's web2 admin link table, in isolated PostgreSQL", {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let link: ManagerAdminLinkRepository;

  async function migrate(target: Pool): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) {
      await target.query(await readFile(new URL(name, directory), 'utf8'));
    }
  }

  beforeEach(async () => {
    schema = `t11_admin_link_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    link = new ManagerAdminLinkRepository(pool);
    await migrate(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('starts with its one row and no default', async () => {
    const rows = await pool.query('SELECT url, token, revision FROM manager_admin_link');

    assert.deepEqual(rows.rows, [{ url: null, token: null, revision: 0 }]);
    assert.deepEqual(await link.read(), { url: null, tokenStored: false, revision: 0 });
    assert.equal(await link.storedToken(), null);
  });

  it('refuses a second row', async () => {
    await assert.rejects(pool.query('INSERT INTO manager_admin_link DEFAULT VALUES'), /duplicate key|unique/i);
    await assert.rejects(pool.query('INSERT INTO manager_admin_link (singleton) VALUES (false)'), /check constraint/i);
  });

  it('stores an address and a token, and answers only that a token is stored', async () => {
    const saved = await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

    assert.deepEqual(saved, { url: ADMIN_URL, tokenStored: true, revision: 1 });
    assert.deepEqual(await link.read(), saved);
    assert.doesNotMatch(JSON.stringify(await link.read()), new RegExp(TOKEN));
    assert.equal(await link.storedToken(), TOKEN);
    const row = await pool.query('SELECT updated_by FROM manager_admin_link');
    assert.equal(row.rows[0].updated_by, 'operator');
  });

  it('keeps the stored token when a write leaves it out, and clears it on null', async () => {
    await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

    assert.deepEqual(await link.write({ url: 'https://admin2.example.com' }, 1, 'operator'), {
      url: 'https://admin2.example.com',
      tokenStored: true,
      revision: 2,
    });
    assert.equal(await link.storedToken(), TOKEN);
    assert.deepEqual(await link.write({ url: ADMIN_URL, token: null }, 2, 'operator'), { url: ADMIN_URL, tokenStored: false, revision: 3 });
    assert.equal(await link.storedToken(), null);
  });

  it('takes the token out with the address, which leaves no default', async () => {
    await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

    assert.deepEqual(await link.write({ url: null }, 1, 'operator'), { url: null, tokenStored: false, revision: 2 });
    assert.equal(await link.storedToken(), null);
  });

  it('writes nothing at a revision another write has moved past', async () => {
    await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'first');

    assert.equal(await link.write({ url: 'https://admin2.example.com', token: null }, 0, 'second'), null);
    assert.deepEqual(await link.read(), { url: ADMIN_URL, tokenStored: true, revision: 1 });
    assert.equal(await link.storedToken(), TOKEN);
  });

  it('refuses a token with no address, and an empty address, from a write that skipped the service', async () => {
    await assert.rejects(pool.query(`UPDATE manager_admin_link SET token = $1`, [TOKEN]), /check constraint/i);
    await assert.rejects(pool.query(`UPDATE manager_admin_link SET url = ''`), /check constraint/i);
  });

  describe("a new deployment's copy of the stored token", () => {
    /** The bundled version the migrations insert first, on a daemon of its own with no ports to reserve. */
    const PLACEMENT = { stackVersionId: 1, slotCap: 99, daemonId: 'synthetic-daemon', table: [] };
    const LINKED: InitialStackSettings = { plain: { ADMIN_API_URL: ADMIN_URL }, secret: {}, copyManagerAdminToken: true };

    async function secretsOf(name: string): Promise<unknown> {
      const row = await pool.query('SELECT stack_settings_secret FROM profiles WHERE name = $1', [name]);
      return row.rows[0]?.stack_settings_secret;
    }

    function groupParams(stackSettings: InitialStackSettings): SharedProfileParams {
      return {
        kind: 'streamer', notes: null, components: null, host: null,
        feed_owner: null, feed_topic: null, private_key: null, public_key: null, stamp_id: null, srt_passphrase: null,
        node_mode: null, rpc_endpoint_source: 'stack', rpc_endpoint: null,
        stack_version_id: 1, engine_settings: {}, stack_settings: stackSettings,
        slot_cap: 99, daemon_id: 'synthetic-daemon', table: [],
      };
    }

    it('puts the stored token in the secret settings at the insert, and the row answered carries none', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      const row = await new ProfileRepository(pool).insertWithFreeSlot('linked', 'streamer', 'DEPLOYING', {}, PLACEMENT, {}, LINKED);

      assert.deepEqual(await secretsOf('linked'), { ADMIN_API_TOKEN: TOKEN });
      assert.deepEqual(await new ProfileRepository(pool).stackSettingsForDeploy('linked'), { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: TOKEN });
      assert.doesNotMatch(JSON.stringify(row), new RegExp(TOKEN));
    });

    it('refuses an insert that asks for the token when none is stored, and leaves no deployment behind', async () => {
      await link.write({ url: ADMIN_URL }, 0, 'operator');

      await assert.rejects(
        new ProfileRepository(pool).insertWithFreeSlot('orphan', 'streamer', 'DEPLOYING', {}, PLACEMENT, {}, LINKED),
        (error: Error) => error.name === 'ManagerAdminTokenMissingError',
      );
      const rows = await pool.query(`SELECT name FROM profiles WHERE name = 'orphan'`);
      assert.equal(rows.rowCount, 0);
    });

    it('puts the stored token in every member of a new group at the insert', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      const { profiles: members } = await new DeploymentGroupRepository(pool).createGroupWithMembers(
        'fleet', STANDARD_GROUP_KIND, [{ name: 'fleet-1' }, { name: 'fleet-2' }], groupParams(LINKED),
      );

      for (const name of ['fleet-1', 'fleet-2']) assert.deepEqual(await secretsOf(name), { ADMIN_API_TOKEN: TOKEN }, name);
      assert.doesNotMatch(JSON.stringify(members), new RegExp(TOKEN));
    });

    it('refuses a whole group when none is stored, and leaves no member behind', async () => {
      await assert.rejects(
        new DeploymentGroupRepository(pool).createGroupWithMembers('bare', STANDARD_GROUP_KIND, [{ name: 'bare-1' }], groupParams(LINKED)),
        (error: Error) => error.name === 'ManagerAdminTokenMissingError',
      );
      const rows = await pool.query(`SELECT name FROM profiles WHERE name = 'bare-1'`);
      assert.equal(rows.rowCount, 0);
    });

    it('copies nothing into an insert that does not ask, even with a token stored', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      await new ProfileRepository(pool).insertWithFreeSlot('plain', 'streamer', 'DEPLOYING', {}, PLACEMENT, {}, {
        plain: { ADMIN_API_URL: '' },
        secret: {},
      });

      assert.deepEqual(await secretsOf('plain'), {});
    });
  });
});
