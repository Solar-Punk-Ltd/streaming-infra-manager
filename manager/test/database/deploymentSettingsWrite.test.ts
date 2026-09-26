/**
 * Saving a deployment's own settings, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T11_TEST_PG_PORT set.
 *
 * A save names the deployment and the revision the page read, and stores
 * nothing once either moved, so two operators editing at once cannot overwrite
 * each other unseen. Only the database can show the guard holding when two
 * saves race, and the page's read never carrying a secret value.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't11_test',
  connectionTimeoutMillis: 10000,
};

const SECRET = 'synthetic-admin-token';
const NOTHING = { plain: {}, secret: {}, remove: [] };

describe('saving a deployment settings, in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;
  let instanceId: string;

  async function migrate(target: Pool): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) {
      await target.query(await readFile(new URL(name, directory), 'utf8'));
    }
  }

  beforeEach(async () => {
    schema = `t11_settings_write_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    profiles = new ProfileRepository(pool);
    await migrate(pool);
    await pool.query(
      `INSERT INTO profiles (name, port_slot, kind, stack_version_id)
       VALUES ('stage', 3, 'custom', (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
    );
    instanceId = (await profiles.findByName('stage'))!.instance_id;
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('stores plain and secret values apart, and answers the page the secret names alone', async () => {
    const revision = await profiles.updateStackSettings(
      'stage',
      { plain: { LOG_LEVEL: 'info', ADMIN_API_URL: '' }, secret: { ADMIN_API_TOKEN: SECRET }, remove: [] },
      { instanceId, expectedRevision: 0 },
    );

    assert.equal(revision, 1);
    const read = await profiles.stackSettingsOf('stage');
    assert.deepEqual(read, { plain: { LOG_LEVEL: 'info', ADMIN_API_URL: '' }, secretKeys: ['ADMIN_API_TOKEN'], revision: 1 });
    assert.doesNotMatch(JSON.stringify(read), new RegExp(SECRET));
    assert.deepEqual(await profiles.stackSettingsForDeploy('stage'), { LOG_LEVEL: 'info', ADMIN_API_URL: '', ADMIN_API_TOKEN: SECRET });
  });

  it('takes a reset key out of whichever column holds it', async () => {
    await profiles.updateStackSettings('stage', { plain: { LOG_LEVEL: 'info' }, secret: { ADMIN_API_TOKEN: SECRET }, remove: [] }, { instanceId, expectedRevision: 0 });

    const revision = await profiles.updateStackSettings('stage', { ...NOTHING, remove: ['LOG_LEVEL', 'ADMIN_API_TOKEN'] }, { instanceId, expectedRevision: 1 });

    assert.equal(revision, 2);
    assert.deepEqual(await profiles.stackSettingsOf('stage'), { plain: {}, secretKeys: [], revision: 2 });
  });

  it('stores nothing for a save made against an older revision', async () => {
    await profiles.updateStackSettings('stage', { ...NOTHING, plain: { LOG_LEVEL: 'info' } }, { instanceId, expectedRevision: 0 });

    const late = await profiles.updateStackSettings('stage', { ...NOTHING, plain: { LOG_LEVEL: 'warn' } }, { instanceId, expectedRevision: 0 });

    assert.equal(late, null);
    assert.deepEqual((await profiles.stackSettingsOf('stage'))?.plain, { LOG_LEVEL: 'info' });
  });

  it('stores nothing for a save made for another instance of the name', async () => {
    const other = await profiles.updateStackSettings('stage', { ...NOTHING, plain: { LOG_LEVEL: 'warn' } }, {
      instanceId: '00000000-0000-4000-8000-000000000000',
      expectedRevision: 0,
    });

    assert.equal(other, null);
    assert.deepEqual(await profiles.stackSettingsOf('stage'), { plain: {}, secretKeys: [], revision: 0 });
  });

  it('lets exactly one of two saves at the same revision through', async () => {
    const [first, second] = await Promise.all([
      profiles.updateStackSettings('stage', { ...NOTHING, plain: { LOG_LEVEL: 'info' } }, { instanceId, expectedRevision: 0 }),
      profiles.updateStackSettings('stage', { ...NOTHING, plain: { LOG_LEVEL: 'warn' } }, { instanceId, expectedRevision: 0 }),
    ]);

    assert.deepEqual([first, second].filter((revision) => revision !== null), [1]);
    assert.equal((await profiles.stackSettingsOf('stage'))?.revision, 1);
  });

  it('answers nothing for a deployment that does not exist', async () => {
    assert.equal(await profiles.stackSettingsOf('missing'), null);
  });
});
