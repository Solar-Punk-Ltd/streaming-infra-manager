/**
 * What the manager upgrade actually does to the host: the Compose commands it
 * runs, in what order, and what it refuses to do.
 *
 * Unit test with a scripted command runner and a scripted health probe, so no
 * Docker daemon, no network and no database are touched. `pnpm test` in
 * manager/. The one thing that does touch disk is the sealed package the
 * source check reads, built by the shared artifact fixture.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ComposeUpgradeOperations } from '../../../src/cli/ComposeUpgradeOperations.js';
import type { CommandResult, CommandRunner } from '../../../src/cli/commandRunner.js';
import type { ManagerUpgradeDatabase } from '../../../src/cli/managerUpgradeDatabase.js';
import type { BundledActivation, BundledShipmentReceipt, BundledShipmentRecord } from '../../../src/domain/versions/BundledShipment.js';
import type { ManagerPublication, ManagerUpgradeRequest } from '../../../src/domain/versions/ManagerUpgrade.js';
import { bundledPackagesRootFor, sealedBundledPackagePathFor } from '../../../src/domain/versions/stackPaths.js';
import { bundledArtifactFixture } from '../../support/bundledArtifactFixture.js';

const PROJECT = 'manager';
const COMPOSE_FILE = '/home/solarpunk/streaming-infra-manager/manager/docker-compose.yml';
const COMPOSE_DIRECTORY = '/home/solarpunk/streaming-infra-manager/manager';
const TOOLCHAIN = 'node v22.9.0 pnpm 9.0.0 Linux/x86_64';
const HEALTH_URL = 'http://api:9876/health';
const POSTGRES_VOLUME = 'manager_manager-pg';
const COMMIT = 'a'.repeat(40);
const DIGEST = 'd'.repeat(64);
const TIMEOUTS = { command: 1000, postgresReady: 300, apiHealthy: 300, pollPause: 10 };

/** The words of a Compose call after its project and file flags, which is what a test cares about. */
function key(argv: readonly string[]): string {
  const directory = argv.indexOf('--project-directory');
  return argv[1] === 'compose' && directory > 0 ? argv.slice(directory + 2).join(' ') : argv.join(' ');
}

class ScriptedRunner {
  readonly calls: string[][] = [];
  private readonly answers = new Map<string, CommandResult[]>();

  answer(call: string, ...results: Partial<CommandResult>[]): this {
    this.answers.set(call, results.map((result) => ({ code: 0, stdout: '', stderr: '', killed: false, signal: null, ...result })));
    return this;
  }

  /** Each call keeps answering with its last scripted result, so a poll needs no repeats. */
  readonly run: CommandRunner = async (argv) => {
    this.calls.push([...argv]);
    const queue = this.answers.get(key(argv));
    if (!queue) return { code: 0, stdout: '', stderr: '', killed: false, signal: null };
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };

  get seen(): string[] {
    return this.calls.map(key);
  }
}

/** What `docker compose ps -a --format json postgres` prints, one line per container. */
function containerList(...states: readonly (readonly [string, string])[]): string {
  return states.map(([state, health], index) =>
    JSON.stringify({ Name: `manager-postgres-${index + 1}`, Service: 'postgres', State: state, Health: health })).join('\n') + '\n';
}
function containers(state: string, health: string): string {
  return containerList([state, health]);
}

/** How the upgrade asks whether one service of the project has a container of its own. */
function serviceProbe(service: string): string {
  return ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.oneoff=False'].join(' ');
}
const API_CONTAINERS = serviceProbe('api');

const JOURNAL: ManagerPublication = { schema: 'journal', revision: '4', buildId: `${COMMIT}-r7`, receipt: null, pending: null };
const FRESH: ManagerPublication = { schema: 'fresh', revision: '0', buildId: null, receipt: null, pending: null };

describe('the manager upgrade against one Compose project', () => {
  let root: string; let versionsRoot: string; let shipmentId: string;
  let request: ManagerUpgradeRequest; let runner: ScriptedRunner;
  let publication: ManagerPublication; let activation: BundledActivation;
  let receipt: BundledShipmentReceipt; let migrated: number;
  let readPublication: () => Promise<ManagerPublication>;
  let steps: string[]; let errors: string[]; let shipment: BundledShipmentRecord | null; let supersedeFails: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-compose-'));
    versionsRoot = join(root, 'versions');
    await mkdir(versionsRoot);
    shipmentId = randomUUID();
    request = {
      shipment: { shipmentId, commit: COMMIT, digest: DIGEST },
      manager: { sourceCommit: 'b'.repeat(40), sourceDigest: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}` },
      project: PROJECT,
    };
    runner = new ScriptedRunner();
    publication = JOURNAL;
    receipt = { shipmentId, versionId: 1, buildId: `${COMMIT}-r7`, publicationRevision: '5', publishedAt: new Date('2026-09-09T00:00:00.000Z') };
    activation = { status: 'published', receipt };
    migrated = 0;
    readPublication = async () => publication;
    steps = []; errors = []; shipment = null; supersedeFails = false;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function database(): ManagerUpgradeDatabase {
    return {
      readPublication: async () => readPublication(),
      migrate: async () => { migrated += 1; steps.push('migrate'); },
      publishBundled: async () => { steps.push('publish'); return activation; },
      supersedeStalePending: async (versionId) => {
        steps.push(`supersede ${versionId}`);
        if (supersedeFails) throw new Error('synthetic journal failure');
        return [];
      },
      find: async () => { steps.push('find'); return shipment; },
      findByMaterialization: async () => null,
      close: async () => {},
    };
  }

  /** A shipment the journal answers with, which is what decides whether its package may go. */
  function published(): BundledShipmentRecord {
    return {
      shipmentId, versionId: receipt.versionId, packageDigest: DIGEST, commitSha: COMMIT, expectedRevision: '4',
      rootPath: join(versionsRoot, 'bundled'), state: 'published', candidateBuildId: receipt.buildId,
      candidateKind: 'new', candidateManifest: null, candidateMetadata: null, materializationId: null,
      artifactDigest: null, candidateContract: null, receipt, createdAt: new Date('2026-09-09T00:00:00.000Z'),
    };
  }

  function operations(options: { publicEdge?: boolean; firstUse?: boolean; health?: number[] } = {}): ComposeUpgradeOperations {
    const statuses = [...(options.health ?? [200])];
    return new ComposeUpgradeOperations(
      { versionsRoot, composeFile: COMPOSE_FILE, toolchain: TOOLCHAIN, publicEdge: options.publicEdge ?? false,
        firstUse: options.firstUse ?? false, timeouts: TIMEOUTS },
      database(),
      runner.run,
      async () => ({ status: statuses.length > 1 ? statuses.shift()! : statuses[0]! }),
      { out: () => assert.fail('the operations write no machine-read line'), err: (line) => errors.push(line) },
    );
  }

  async function sealPackage(): Promise<void> {
    await mkdir(bundledPackagesRootFor(versionsRoot), { recursive: true });
    const fixture = await bundledArtifactFixture(bundledPackagesRootFor(versionsRoot), { commit: COMMIT, shipmentId });
    request = { ...request, shipment: { ...request.shipment, digest: fixture.sealed.identity.digest } };
  }

  describe('deciding about Postgres before it reads anything', () => {
    it('reads through a Postgres that is already running and healthy, starting nothing', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containers('running', 'healthy') });

      assert.deepEqual(await operations().readPublication(request), JOURNAL);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres']);
    });

    it('reads through a healthy Postgres that a container of an earlier run is listed before', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containerList(['exited', ''], ['running', 'healthy']) });

      assert.deepEqual(await operations().readPublication(request), JOURNAL);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres'], 'nothing is started for a database that is already up');
    });

    it('starts a Postgres whose container exists but is stopped, and waits for it to become healthy', async () => {
      runner.answer('ps -a --format json postgres',
        { stdout: containers('exited', '') }, { stdout: containers('running', 'starting') }, { stdout: containers('running', 'healthy') });

      assert.deepEqual(await operations().readPublication(request), JOURNAL);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', 'up -d --no-build postgres',
        'ps -a --format json postgres', 'ps -a --format json postgres']);
    });

    /** No container, no data volume and no api container: nothing has ever run here. */
    function scriptFirstUse(): void {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(`docker volume inspect ${POSTGRES_VOLUME}`, { code: 1, stderr: 'no such volume' });
      runner.answer(API_CONTAINERS, { stdout: '' });
    }

    it('treats a host with no container and no data volume as first use, and starts Postgres for it', async () => {
      scriptFirstUse();
      publication = FRESH;

      assert.deepEqual(await operations().readPublication(request), FRESH);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', `docker volume inspect ${POSTGRES_VOLUME}`, API_CONTAINERS,
        'up -d --no-build postgres', 'ps -a --format json postgres']);
    });

    it('leaves the one-off container this upgrade runs in out of the api containers it counts', async () => {
      scriptFirstUse();
      // What a Compose listing would answer inside the one-off container of this very upgrade.
      runner.answer('ps -aq api', { stdout: 'deadbeef0001\n' });
      publication = FRESH;

      assert.deepEqual(await operations().readPublication(request), FRESH);
      assert.equal(runner.seen.includes('ps -aq api'), false, 'a Compose listing with -a counts this upgrade own container');
    });

    it('refuses a first use whose database turns out not to be empty', async () => {
      scriptFirstUse();
      publication = JOURNAL;

      await assert.rejects(operations().readPublication(request), /empty/i);
    });

    it('starts a stopped Postgres that still has its data volume, and never calls that revision zero', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(`docker volume inspect ${POSTGRES_VOLUME}`, { code: 0, stdout: '[]' });

      assert.deepEqual(await operations().readPublication(request), JOURNAL);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', `docker volume inspect ${POSTGRES_VOLUME}`,
        'up -d --no-build postgres', 'ps -a --format json postgres']);
    });

    it('refuses a host that has an api container but no data volume, and says what it found', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' });
      runner.answer(`docker volume inspect ${POSTGRES_VOLUME}`, { code: 1, stderr: 'no such volume' });
      runner.answer(API_CONTAINERS, { stdout: 'c0ffee\n' });

      await assert.rejects(operations().readPublication(request), (error: Error) => {
        assert.match(error.message, new RegExp(POSTGRES_VOLUME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, /api/);
        return true;
      });
      assert.equal(runner.seen.includes('up -d --no-build postgres'), false, 'nothing was started');
    });

    it('refuses a database that is not empty where the deploy saw a host that had never run the manager', async () => {
      // Preparing the one-off container this upgrade runs in can create the project's volumes,
      // so the volume its own probe finds proves nothing and the deploy's answer decides.
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(`docker volume inspect ${POSTGRES_VOLUME}`, { code: 0, stdout: '[]' });
      publication = JOURNAL;

      await assert.rejects(operations({ firstUse: true }).readPublication(request), /empty/i);
    });

    it('reads a fresh schema through the first use the deploy decided', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(`docker volume inspect ${POSTGRES_VOLUME}`, { code: 0, stdout: '[]' });
      publication = FRESH;

      assert.deepEqual(await operations({ firstUse: true }).readPublication(request), FRESH);
    });

    it('refuses when Postgres never becomes healthy rather than reading through it', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containers('running', 'starting') });

      await assert.rejects(operations().readPublication(request), /healthy/i);
    });

    it('lets a failed schema read through instead of reporting an empty database', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containers('running', 'healthy') });
      readPublication = async () => { throw new Error('synthetic connection reset'); };

      await assert.rejects(operations().readPublication(request), /connection reset/);
    });
  });

  describe('stopping the api', () => {
    it('stops only the api and checks that no api container is left running', async () => {
      runner.answer('ps -q api', { stdout: '' });

      await operations().stopApi(request);

      assert.deepEqual(runner.seen, ['stop api', 'ps -q api']);
    });

    it('refuses when an api container is still running after the stop', async () => {
      runner.answer('ps -q api', { stdout: 'c0ffee\n' });

      await assert.rejects(operations().stopApi(request), /still running/i);
    });
  });

  describe('checking the shipped sources', () => {
    it('accepts the sealed package whose manifest carries the identity of this upgrade', async () => {
      await sealPackage();

      await operations().installSources(request);

      assert.deepEqual(runner.seen, [], 'the image was built before the guard, so nothing is installed here');
    });

    it('refuses a package whose manifest names another digest, before anything is published', async () => {
      await sealPackage();
      const altered = { ...request, shipment: { ...request.shipment, digest: 'c'.repeat(64) } };

      await assert.rejects(operations().installSources(altered), /digest|identity/i);
    });

    it('refuses when the shipped package is not where the deploy leaves it', async () => {
      await assert.rejects(operations().installSources(request), /package/i);
    });
  });

  describe('publishing', () => {
    it('migrates before it publishes, because the old api is stopped by now', async () => {
      await sealPackage();

      assert.deepEqual(await operations().publish(request), receipt);
      assert.equal(migrated, 1);
    });

    it('supersedes what it left behind and sweeps the packages, after the publication and never before', async () => {
      await sealPackage();
      shipment = published();

      assert.deepEqual(await operations().publish(request), receipt);

      assert.deepEqual(steps, ['migrate', 'publish', `supersede ${receipt.versionId}`, 'find']);
      assert.equal(existsSync(sealedBundledPackagePathFor(versionsRoot, shipmentId)), false, 'the shipped package is gone from the host');
      assert.deepEqual(errors, [`[cli] removed bundled.packages/sealed-${shipmentId}`]);
    });

    it('keeps the publication when the sweep cannot finish, and says what stopped it', async () => {
      await sealPackage();
      supersedeFails = true;

      assert.deepEqual(await operations().publish(request), receipt);

      assert.match(errors.join('\n'), /swept|sweep/i);
      assert.equal(existsSync(sealedBundledPackagePathFor(versionsRoot, shipmentId)), true, 'and removed nothing');
    });

    it('refuses when a newer publication won the race', async () => {
      await sealPackage();
      activation = { status: 'superseded', shipmentId };

      await assert.rejects(operations().publish(request), /newer publication/i);
    });
  });

  describe('reporting a command that failed', () => {
    /** A resolved Compose configuration carries DATABASE_URL, so its output never reaches a log. */
    const RESOLVED_CONFIGURATION = 'DATABASE_URL: postgres://manager:synthetic-password@postgres:5432/manager';

    it('names the subcommand, the project and the exit code, and quotes nothing the command printed', async () => {
      runner.answer('up -d --no-build --remove-orphans', { code: 17, stderr: RESOLVED_CONFIGURATION });

      await assert.rejects(operations().startProject(request), (error: Error) => {
        assert.match(error.message, /up -d --no-build --remove-orphans/);
        assert.match(error.message, new RegExp(`\\b${PROJECT}\\b`));
        assert.match(error.message, /17/);
        assert.equal(error.message.includes('synthetic-password'), false, 'what Compose printed never reaches the deploy log');
        assert.match(error.message, /Run the same docker compose command on the host to see its output\./);
        return true;
      });
    });

    it('says a command was killed rather than calling that an exit code', async () => {
      runner.answer('up -d --no-build --remove-orphans', { code: -1, killed: true, signal: 'SIGTERM' });

      await assert.rejects(operations().startProject(request), (error: Error) => {
        assert.match(error.message, /killed after/);
        assert.equal(error.message.includes('-1'), false, 'a killed command never exited with anything');
        return true;
      });
    });
  });

  describe('starting the project', () => {
    it('starts the public edge with the project when the deploy asked for it', async () => {
      await operations({ publicEdge: true }).startProject(request);

      assert.deepEqual(runner.seen, ['--profile public up -d --no-build --remove-orphans']);
    });

    it('removes the edge by name without a domain, and checks that it is gone', async () => {
      runner.answer('--profile public ps -q edge', { stdout: '' });

      await operations().startProject(request);

      assert.deepEqual(runner.seen, ['up -d --no-build --remove-orphans', '--profile public rm -sf edge', '--profile public ps -q edge']);
    });

    it('refuses when the edge is still running with no domain set, because the host answers on 80 and 443', async () => {
      runner.answer('--profile public ps -q edge', { stdout: 'c0ffee\n' });

      await assert.rejects(operations().startProject(request), /80 and 443/);
    });
  });

  describe('verifying the project', () => {
    it('waits for the api to answer its health check and for the edge to match the deploy', async () => {
      runner.answer('--profile public ps -q edge', { stdout: '' });

      await operations({ health: [503, 200] }).verifyProject(request);

      assert.deepEqual(runner.seen, ['--profile public ps -q edge']);
    });

    it('refuses when the api never answers, which keeps the guard held', async () => {
      await assert.rejects(operations({ health: [503] }).verifyProject(request), (error: Error) => {
        assert.match(error.message, new RegExp(HEALTH_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      });
    });

    it('refuses when the edge is running and the deploy did not ask for it', async () => {
      runner.answer('--profile public ps -q edge', { stdout: 'c0ffee\n' });

      await assert.rejects(operations().verifyProject(request), /edge/i);
    });

    it('refuses when the deploy asked for the edge and it is not running', async () => {
      runner.answer('--profile public ps -q edge', { stdout: '' });

      await assert.rejects(operations({ publicEdge: true }).verifyProject(request), /edge/i);
    });
  });

  it('names the project, the compose file and its directory on every Compose call', async () => {
    runner.answer('ps -q api', { stdout: '' });

    await operations().stopApi(request);

    for (const argv of runner.calls) {
      assert.deepEqual(argv.slice(0, 8),
        ['docker', 'compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--project-directory', COMPOSE_DIRECTORY]);
    }
  });
});
