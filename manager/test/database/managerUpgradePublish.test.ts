/**
 * The publishing step of a manager upgrade, against a real database and real
 * files: the step that turns a shipped package into the build the bundled
 * version deploys from.
 *
 * Gated on T04B_TEST_PG_PORT, like its neighbours. Start a throwaway Postgres
 * on the machine running the tests and point that variable at its port.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ComposeUpgradeOperations } from '../../src/cli/ComposeUpgradeOperations.js';
import type { CommandRunner } from '../../src/cli/commandRunner.js';
import { PostgresManagerUpgradeDatabase } from '../../src/cli/managerUpgradeDatabase.js';
import type { ManagerUpgradeRequest } from '../../src/domain/versions/ManagerUpgrade.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { buildsRootFor, bundledPackageClaimsRootFor, bundledPackagesRootFor, sealedBundledPackagePathFor } from '../../src/domain/versions/stackPaths.js';
import { bundledArtifactFixture } from '../support/bundledArtifactFixture.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const COMMIT = 'a'.repeat(40);
const COMPOSE_FILE = '/synthetic-main-v2/manager/docker-compose.yml';
const TOOLCHAIN = 'synthetic-build-toolchain';
/** Publishing runs no command and probes nothing, so both seams refuse to be used. */
const noRunner: CommandRunner = async (argv) => { throw new Error(`publishing ran a command: ${argv.join(' ')}`); };

describe('the manager upgrade publishing what the deploy shipped', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let root: string; let versionsRoot: string; let shipmentId: string;
  let admin: Pool; let reader: Pool; let name: string;
  let database: PostgresManagerUpgradeDatabase; let operations: ComposeUpgradeOperations;
  let versions: PostgresStackVersionRepository; let request: ManagerUpgradeRequest; let said: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-publish-'));
    versionsRoot = join(root, 'versions');
    await mkdir(bundledPackagesRootFor(versionsRoot), { recursive: true });
    shipmentId = randomUUID();
    name = `t04b_upgrade_${randomBytes(8).toString('hex')}`;
    said = [];
    admin = new pg.Pool(connection);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = `postgres://postgres@127.0.0.1:${port}/${name}`;
    reader = new pg.Pool({ ...connection, database: name });
    versions = new PostgresStackVersionRepository(reader);
    database = new PostgresManagerUpgradeDatabase(url, versionsRoot);
    operations = new ComposeUpgradeOperations(
      { versionsRoot, composeFile: COMPOSE_FILE, toolchain: TOOLCHAIN, publicEdge: false, firstUse: false },
      database, noRunner, async () => { throw new Error('publishing probed the api'); },
      { out: () => assert.fail('publishing writes no machine-read line'), err: (line) => said.push(line) },
    );
    request = {
      shipment: { shipmentId, commit: COMMIT, digest: 'd'.repeat(64) },
      manager: { sourceCommit: 'b'.repeat(40), sourceDigest: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}` },
      project: 'manager',
    };
  });

  afterEach(async () => {
    await database?.close();
    await reader?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
    await rm(root, { recursive: true, force: true });
  });

  /** A sealed package where the deploy leaves it, and the request that names it. */
  async function shipped(): Promise<void> {
    const fixture = await bundledArtifactFixture(bundledPackagesRootFor(versionsRoot), { commit: COMMIT, shipmentId });
    request = { ...request, shipment: { ...request.shipment, digest: fixture.sealed.identity.digest } };
  }

  it('migrates an empty database and moves the bundled version onto the build it published', async () => {
    await shipped();

    const receipt = await operations.publish(request);

    const bundled = (await versions.findByName('bundled'))!;
    assert.equal(bundled.layout, 'builds');
    assert.equal(bundled.buildId, receipt.buildId);
    assert.equal(receipt.shipmentId, shipmentId);
    assert.deepEqual(await readdir(buildsRootFor(versionsRoot, 'bundled')), [receipt.buildId]);
  });

  it('removes the package it published and the copy it claimed, so their secrets do not stay on the host', async () => {
    await shipped();

    const receipt = await operations.publish(request);

    assert.equal(existsSync(sealedBundledPackagePathFor(versionsRoot, shipmentId)), false);
    assert.equal(existsSync(join(bundledPackageClaimsRootFor(versionsRoot), shipmentId)), false);
    assert.equal(existsSync(join(buildsRootFor(versionsRoot, 'bundled'), receipt.buildId)), true, 'the build it published stays');
    // The package is renamed into the claim when publication takes it over, so the claim is the one copy left to remove.
    assert.deepEqual(said.filter(line => line.includes(shipmentId)), [`[cli] removed bundled.packages/claims/${shipmentId}`]);
  });

  it('answers the same receipt on a second run of the same shipment, without building again', async () => {
    await shipped();
    const first = await operations.publish(request);

    const again = await operations.publish(request);

    assert.deepEqual(again, first);
    assert.deepEqual(await readdir(buildsRootFor(versionsRoot, 'bundled')), [first.buildId]);
  });

  it('refuses a package that changed after it was sealed, and leaves the bundled version where it was', async () => {
    await shipped();
    await writeFile(join(bundledPackagesRootFor(versionsRoot), `sealed-${shipmentId}`, 'unexpected'), 'added after sealing');

    await assert.rejects(operations.publish(request), /inventory|package/i);

    const bundled = (await versions.findByName('bundled'))!;
    assert.equal(bundled.layout, 'legacy');
    assert.equal(bundled.buildId, null);
  });
});
