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
import type { CommandResult, CommandRunner } from '../../src/cli/commandRunner.js';
import { PostgresManagerUpgradeDatabase } from '../../src/cli/managerUpgradeDatabase.js';
import { runManagerUpgrade, type ManagerUpgradeRequest } from '../../src/domain/versions/ManagerUpgrade.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { MANAGER_POSTGRES_VOLUME } from '../../src/domain/versions/managerProject.js';
import { buildsRootFor, bundledPackageClaimsRootFor, bundledPackagesRootFor, managerUpgradeGuardRootFor, sealedBundledPackagePathFor } from '../../src/domain/versions/stackPaths.js';
import { bundledArtifactFixture } from '../support/bundledArtifactFixture.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const COMMIT = 'a'.repeat(40);
const COMPOSE_FILE = '/synthetic-main-v2/manager/docker-compose.yml';
const TOOLCHAIN = 'synthetic-build-toolchain';
const API_CONTAINER = 'c0ffee';
/** Publishing runs no command and probes nothing, so both seams refuse to be used. */
const noRunner: CommandRunner = async (argv) => { throw new Error(`publishing ran a command: ${argv.join(' ')}`); };

/**
 * A host that answers a whole upgrade: a database that is already healthy, an
 * api that is gone once it is stopped and back once the project is started, and
 * no edge.
 */
function hostRunner(imageId: string): CommandRunner {
  const postgres = JSON.stringify({ Name: 'manager-postgres-1', Service: 'postgres', State: 'running', Health: 'healthy' });
  const answer = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', killed: false, signal: null });
  let apiAsked = 0;
  return async (argv) => {
    const line = argv.join(' ');
    if (line.endsWith('ps -a --format json postgres')) return answer(`${postgres}\n`);
    if (line.endsWith('ps -q api')) return answer(apiAsked++ === 0 ? '' : `${API_CONTAINER}\n`);
    if (line.startsWith('docker inspect')) return answer(`${imageId}\n`);
    return answer('');
  };
}

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
      { versionsRoot, composeFile: COMPOSE_FILE, toolchain: TOOLCHAIN, publicEdge: false, firstUse: false,
        postgresVolume: MANAGER_POSTGRES_VOLUME, apiHealthUrl: 'http://api:9876/health' },
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

  it('carries a whole first use run through, although its own migration turns the schema it read', async () => {
    await shipped();
    // The empty database is only empty until this run migrates it, and every later read of the
    // same run sees the journal that migration made.
    const host = new ComposeUpgradeOperations(
      { versionsRoot, composeFile: COMPOSE_FILE, toolchain: TOOLCHAIN, publicEdge: false, firstUse: true,
        postgresVolume: MANAGER_POSTGRES_VOLUME, apiHealthUrl: 'http://api:9876/health' },
      database, hostRunner(request.manager.imageId), async () => ({ status: 200 }),
      { out: () => assert.fail('the operations write no machine-read line'), err: (line) => said.push(line) },
    );
    const mutableRoot = join(root, 'manager');
    await mkdir(mutableRoot);

    const result = await runManagerUpgrade({ guardRoot: managerUpgradeGuardRootFor(versionsRoot), mutableRoot }, request, host);

    assert.equal(result.state, 'completed');
    const bundled = (await versions.findByName('bundled'))!;
    assert.equal(bundled.layout, 'builds');
    assert.equal(bundled.buildId, result.receipt.buildId);
    assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'and holds nothing afterwards');
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
