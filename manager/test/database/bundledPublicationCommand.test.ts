import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { BundledPublicationCommand } from '../../src/domain/versions/BundledPublicationCommand.js';
import { PostgresBundledShipmentRepository } from '../../src/domain/versions/PostgresBundledShipmentRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { BundledArtifactMaterializer } from '../../src/domain/versions/BundledArtifactMaterializer.js';
import { verifyBundledArtifact } from '../../src/domain/versions/bundledArtifactFiles.js';
import { stackRootOf } from '../../src/domain/versions/stackPaths.js';
import { bundledArtifactFixture } from '../support/bundledArtifactFixture.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
describe('fixed bundled publication command using the actual journal and files', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let admin: Pool; let pool: Pool; let schema: string; let root: string;
  let shipments: PostgresBundledShipmentRepository; let versions: PostgresStackVersionRepository; let command: BundledPublicationCommand;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-publication-command-'));
    schema = `t04b_publication_command_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const path = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(path)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, path), 'utf8'));
    shipments = new PostgresBundledShipmentRepository(pool, join(root, 'bundled'));
    versions = new PostgresStackVersionRepository(pool);
    command = new BundledPublicationCommand(shipments, join(root, 'claims'));
  });
  afterEach(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    await rm(root, { recursive: true, force: true });
  });
  async function item(commit = A, input?: string) { return bundledArtifactFixture(root, { commit, input }); }
  function request(value: Awaited<ReturnType<typeof item>>, reuseFromShipmentId?: string) {
    return { identity: value.sealed.identity, readyPath: value.sealed.root, toolchain: 'synthetic-build-toolchain', reuseFromShipmentId };
  }
  async function published(commit = A) {
    const value = await item(commit); const outcome = await command.publish(request(value));
    assert.equal(outcome.status, 'published');
    return { value, outcome, record: (await shipments.find(value.record.shipmentId))! };
  }
  function path(record: Awaited<ReturnType<typeof published>>['record']) { return stackRootOf({ rootPath: record.rootPath, layout: 'builds', buildId: record.candidateBuildId }); }

  it('publishes a complete owned artifact and leaves the legacy tree bytes unchanged', async () => {
    const legacy = join(root, 'legacy'); await mkdir(legacy); await writeFile(join(legacy, 'mounted'), 'legacy-mounted-A');
    const result = await published();
    await verifyBundledArtifact(path(result.record), result.record);
    const current = (await versions.findByName('bundled'))!;
    assert.equal(current.buildId, result.record.candidateBuildId); assert.equal(current.layout, 'builds');
    assert.equal(await readFile(join(legacy, 'mounted'), 'utf8'), 'legacy-mounted-A');
    assert.match(result.record.candidateBuildId!, new RegExp(`^${A}-r[1-9][0-9]*$`));
  });
  it('publishes B while retaining all A artifact bytes, without pruning', async () => {
    const a = await published(A); const before = await readFile(join(path(a.record), '.stack-manifest.json'));
    const b = await published(B); const current = (await versions.findByName('bundled'))!;
    assert.equal(current.buildId, b.record.candidateBuildId); assert.equal(current.previousBuildId, a.record.candidateBuildId);
    assert.deepEqual(await readFile(join(path(a.record), '.stack-manifest.json')), before);
  });
  it('returns A receipt after C even when A package and artifact no longer exist', async () => {
    const a = await published(A); await published(B); await published(C);
    await rm(join(root, 'claims', a.record.shipmentId), { recursive: true }); await rm(path(a.record), { recursive: true });
    const before = (await versions.findByName('bundled'))!;
    assert.deepEqual(await command.publish(request(a.value)), a.outcome);
    assert.deepEqual(await versions.findByName('bundled'), before);
  });
  it('resumes the exact prepared candidate after the package disappears', async () => {
    const value = await item(); await shipments.register(value.sealed.identity);
    await shipments.reserveCandidate(value.record.shipmentId, { buildId: A, kind: 'new', manifest: value.record.candidateManifest! });
    await new BundledArtifactMaterializer(shipments).materialize(value.record.shipmentId, async () => value.sealed);
    await rm(value.sealed.root, { recursive: true });
    const before = (await shipments.find(value.record.shipmentId))!;
    const result = await command.publish(request(value)); assert.equal(result.status, 'published');
    assert.equal((await shipments.find(value.record.shipmentId))!.materializationId, before.materializationId);
  });
  it('refuses a different identity with the same shipment UUID before reading the package', async () => {
    const a = await published(); const before = await versions.findByName('bundled');
    await assert.rejects(command.publish({ ...request(a.value), identity: { ...a.value.sealed.identity, digest: 'e'.repeat(64) } }), /identity/i);
    assert.deepEqual(await versions.findByName('bundled'), before);
  });
  it('retains failed package verification and does not publish partial bytes', async () => {
    const value = await item(); await writeFile(join(value.sealed.root, 'unexpected'), 'partial');
    await assert.rejects(command.publish(request(value)), /inventory|package/i);
    assert.equal((await versions.findByName('bundled'))!.layout, 'legacy');
    assert.equal(await readFile(join(root, 'claims', value.record.shipmentId, 'payload', 'unexpected'), 'utf8'), 'partial');
  });
  it('refuses an arbitrary ready path before registering or moving anything', async () => {
    const value = await item(); const other = join(root, 'legacy-mounted'); await mkdir(other);
    await writeFile(join(other, 'keep'), 'original');
    await assert.rejects(command.publish({ ...request(value), readyPath: other }), /owned package path/i);
    assert.equal(await shipments.find(value.record.shipmentId), null);
    assert.equal(await readFile(join(other, 'keep'), 'utf8'), 'original');
  });
  it('supports reuse only through an exact already-published journal artifact', async () => {
    const a = await published(); const same = await item();
    const result = await command.publish(request(same, a.record.shipmentId)); assert.equal(result.status, 'published');
    assert.equal((await shipments.find(same.record.shipmentId))!.candidateBuildId, a.record.candidateBuildId);
    const different = await item(A, 'changed'); const before = await versions.findByName('bundled');
    await assert.rejects(command.publish(request(different, a.record.shipmentId)), /input|artifact/i);
    assert.deepEqual(await versions.findByName('bundled'), before);
  });
});
