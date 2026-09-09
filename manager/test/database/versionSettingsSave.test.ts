/**
 * Two settings saves arriving together, against a real PostgreSQL.
 *
 * `T04B_TEST_PG_PORT` and database `t04b_test`, the way the rest of this
 * directory is run.
 *
 * The generation is what makes a settings save safe to offer on a page: two
 * operators with the page open, or one page and one editing session over ssh,
 * both name the revision they loaded, and only the first of them lands. What
 * must never happen is both landing, because the second would be writing over
 * bytes it never saw. The row comes from the real repository here, so the
 * refusal is the one an operator would actually get.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import pg, { type Pool } from 'pg';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createVersionsRouter } from '../../src/api/routes/versions.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { commitHostConfig } from '../../src/domain/versions/hostConfigCapture.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't04b_test',
  connectionTimeoutMillis: 5000,
};

const COMMIT = 'e'.repeat(40);
const HOST_ENV = ['# The token this host was given.', 'API_AUTH_TOKEN=first', ''].join('\n');

describe('settings saves in isolated PostgreSQL schemas', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let server: http.Server;
  let url: string;
  let configRoot: string;
  let id: number;

  beforeEach(async () => {
    schema = `t04b_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, application_name: schema, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }

    const versionsRoot = mkdtempSync(join(tmpdir(), 'settings-save-'));
    configRoot = join(versionsRoot, 'bundled');
    mkdirSync(configRoot, { recursive: true });
    await commitHostConfig(configRoot, { '.env': Buffer.from(HOST_ENV, 'utf8') });

    const repository = new PostgresStackVersionRepository(pool);
    id = (await repository.findByName('bundled'))!.id;
    await pool.query(
      "UPDATE stack_versions SET commit_sha = $2, layout = 'builds', build_id = $2, root_path = $3 WHERE id = $1",
      [id, COMMIT, configRoot],
    );

    const service = new StackVersionService(
      repository,
      new FakeScriptSpawner(),
      new EventBus(),
      versionsRoot,
      { openReferences: async () => [] },
      join(versionsRoot, 'bundled-tree'),
    );
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use('/versions', createVersionsRouter(service));
    app.use(notFound);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  function save(value: string): Promise<Response> {
    return fetch(`${url}/versions/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedGeneration: 1,
        files: [{ path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value }] }],
      }),
    });
  }

  it('lands the first of two saves and refuses the second with the revision it has to reload', async () => {
    const answers = await Promise.all([save('from-one'), save('from-two')]);
    const bodies = await Promise.all(answers.map((answer) => answer.json()));

    const statuses = answers.map((answer) => answer.status).sort();
    assert.deepEqual(statuses, [200, 409]);

    const landed = bodies[answers.findIndex((answer) => answer.status === 200)] as { generation: number };
    const refused = bodies[answers.findIndex((answer) => answer.status === 409)] as {
      error: string;
      generation: number;
    };
    assert.deepEqual(landed, { generation: 2 });
    assert.equal(refused.error, 'settings_changed');
    assert.equal(refused.generation, 2);
  });

  it('leaves the file holding one of the two values and the comment above it', async () => {
    await Promise.all([save('from-one'), save('from-two')]);

    const written = readFileSync(join(configRoot, '.env'), 'utf8');
    const values = ['from-one', 'from-two'].filter((value) => written.includes(value));
    assert.deepEqual(values.length, 1, written.replace(/from-\w+/g, 'value'));
    assert.equal(written.startsWith('# The token this host was given.\n'), true);
  });

  it('moves the revision on by one, never by two', async () => {
    await Promise.all([save('from-one'), save('from-two')]);

    const manifest = JSON.parse(readFileSync(join(configRoot, '.config-revision.json'), 'utf8'));
    assert.equal(manifest.generation, 2);
  });

  it('takes the next save once the page has reloaded onto the new revision', async () => {
    await Promise.all([save('from-one'), save('from-two')]);

    const again = await fetch(`${url}/versions/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedGeneration: 2,
        files: [{ path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value: 'from-three' }] }],
      }),
    });

    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { generation: 3 });
    assert.match(readFileSync(join(configRoot, '.env'), 'utf8'), /^API_AUTH_TOKEN=from-three$/m);
  });
});
