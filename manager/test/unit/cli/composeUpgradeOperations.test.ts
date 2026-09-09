/**
 * What the manager upgrade actually does to the host: the Compose commands it
 * runs, in what order, what it refuses to do, and what one whole run of it
 * looks like from the first read to the bundled build it waits for.
 *
 * Unit test with a scripted command runner and a scripted health probe, so no
 * Docker daemon, no network and no database are touched. `pnpm test` in
 * manager/.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ComposeUpgradeOperations, httpHealthProbe } from '../../../src/cli/ComposeUpgradeOperations.js';
import type { CommandResult, CommandRunner } from '../../../src/cli/commandRunner.js';
import type { BundledVersionState, ManagerUpgradeDatabase } from '../../../src/cli/managerUpgradeDatabase.js';
import { runManagerUpgrade, type ManagerPublication, type ManagerUpgradeRequest } from '../../../src/domain/versions/ManagerUpgrade.js';
import { MANAGER_POSTGRES_VOLUME } from '../../../src/domain/versions/managerProject.js';
import { managerUpgradeGuardRootFor } from '../../../src/domain/versions/stackPaths.js';

const PROJECT = 'manager';
const COMPOSE_FILE = '/home/solarpunk/streaming-infra-manager/manager/docker-compose.yml';
const COMPOSE_DIRECTORY = '/home/solarpunk/streaming-infra-manager/manager';
/** A port no default would produce, so a URL built anywhere but from these settings would not match. */
const HEALTH_URL = 'http://api:19876/health';
const POSTGRES_VOLUME = `${PROJECT}_${MANAGER_POSTGRES_VOLUME}`;
const PIN = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'f'.repeat(64)}`;
const API_CONTAINER = 'c0ffee';
const TIMEOUTS = { command: 1000, postgresReady: 300, apiHealthy: 300, bundledBuild: 300, pollPause: 10 };

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
  readonly run: CommandRunner = async (argv, options) => {
    assert.equal(options.timeoutMs, TIMEOUTS.command, `${key(argv)} ran without the bound the settings gave`);
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
/** How the upgrade asks whether the project's database volume is there at all. */
const VOLUME_PROBE = `docker volume ls -q --filter name=^${POSTGRES_VOLUME}$`;

/** Fails a probe that never returns, instead of leaving the suite to time out. */
function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the probe is still reading the answer body')), 500);
  })]).finally(() => clearTimeout(timer));
}

const CURRENT: ManagerPublication = { schema: 'current' };
const FRESH: ManagerPublication = { schema: 'fresh' };

/** The bundled row as the api's boot leaves it while it builds, and once it is done. */
function bundledRow(over: Partial<BundledVersionState> = {}): BundledVersionState {
  return { status: 'ready', layout: 'builds', gitRef: PIN, commitSha: PIN, buildId: PIN, lastError: null, ...over };
}

describe('the manager upgrade against one Compose project', () => {
  let root: string; let versionsRoot: string; let bundledStackRoot: string;
  let request: ManagerUpgradeRequest; let runner: ScriptedRunner;
  let publication: ManagerPublication; let migrated: number;
  let readPublication: () => Promise<ManagerPublication>;
  let bundledStates: BundledVersionState[];
  let steps: string[]; let errors: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-compose-'));
    versionsRoot = join(root, 'versions');
    await mkdir(versionsRoot);
    // The tree the manager ships with, whose parent holds the commit the deploy pinned.
    bundledStackRoot = join(root, 'manager', 'swarm-hls-stream');
    await mkdir(bundledStackRoot, { recursive: true });
    await writeFile(join(root, 'manager', '.stack-commit'), `${PIN}\n`);
    request = {
      manager: { sourceCommit: 'b'.repeat(40), sourceDigest: 'e'.repeat(64), imageId: IMAGE_ID },
      project: PROJECT,
    };
    runner = new ScriptedRunner();
    publication = CURRENT;
    migrated = 0;
    readPublication = async () => publication;
    bundledStates = [bundledRow()];
    steps = []; errors = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function database(): ManagerUpgradeDatabase {
    return {
      readPublication: async () => readPublication(),
      migrate: async () => { migrated += 1; steps.push('migrate'); },
      readBundledVersion: async () => {
        steps.push('read-bundled');
        return bundledStates.length > 1 ? bundledStates.shift()! : bundledStates[0]!;
      },
      close: async () => {},
    };
  }

  function operations(options: { publicEdge?: boolean; firstUse?: boolean; health?: number[] } = {}): ComposeUpgradeOperations {
    const statuses = [...(options.health ?? [200])];
    return new ComposeUpgradeOperations(
      { versionsRoot, composeFile: COMPOSE_FILE, bundledStackRoot, publicEdge: options.publicEdge ?? false,
        firstUse: options.firstUse ?? false, postgresVolume: MANAGER_POSTGRES_VOLUME, apiHealthUrl: HEALTH_URL, timeouts: TIMEOUTS },
      database(),
      runner.run,
      async () => ({ status: statuses.length > 1 ? statuses.shift()! : statuses[0]! }),
      { out: () => assert.fail('the operations write no machine-read line'), err: (line) => errors.push(line) },
    );
  }

  describe('deciding about Postgres before it reads anything', () => {
    it('reads through a Postgres that is already running and healthy, starting nothing', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containers('running', 'healthy') });

      assert.deepEqual(await operations().readPublication(request), CURRENT);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres']);
    });

    it('reads through a healthy Postgres that a container of an earlier run is listed before', async () => {
      runner.answer('ps -a --format json postgres', { stdout: containerList(['exited', ''], ['running', 'healthy']) });

      assert.deepEqual(await operations().readPublication(request), CURRENT);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres'], 'nothing is started for a database that is already up');
    });

    it('reads a container listing an older Compose printed as one JSON array', async () => {
      runner.answer('ps -a --format json postgres',
        { stdout: '[{"Name":"manager-postgres-1","Service":"postgres","State":"running","Health":"healthy"}]' });

      assert.deepEqual(await operations().readPublication(request), CURRENT);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres']);
    });

    it('refuses a container listing that is not JSON, rather than reading it as no containers at all', async () => {
      runner.answer('ps -a --format json postgres', { stdout: 'Cannot connect to the Docker daemon.\n' });

      await assert.rejects(operations().readPublication(request), /JSON/);
    });

    it('starts a Postgres whose container exists but is stopped, and waits for it to become healthy', async () => {
      runner.answer('ps -a --format json postgres',
        { stdout: containers('exited', '') }, { stdout: containers('running', 'starting') }, { stdout: containers('running', 'healthy') });
      runner.answer(VOLUME_PROBE, { stdout: `${POSTGRES_VOLUME}\n` });

      assert.deepEqual(await operations().readPublication(request), CURRENT);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', VOLUME_PROBE, 'up -d --no-build postgres',
        'ps -a --format json postgres', 'ps -a --format json postgres']);
    });

    it('refuses a stopped Postgres whose data volume went missing under an installed api', async () => {
      // Compose would start this container against a volume it creates on the spot, and the empty
      // database that comes up looks exactly like a host that never had one.
      runner.answer('ps -a --format json postgres', { stdout: containers('exited', '') });
      runner.answer(VOLUME_PROBE, { stdout: '' });
      runner.answer(API_CONTAINERS, { stdout: 'c0ffee\n' });

      await assert.rejects(operations().readPublication(request), /volume/i);
      assert.equal(runner.seen.includes('up -d --no-build postgres'), false, 'and starts nothing');
    });

    /** No container, no data volume and no api container: nothing has ever run here. */
    function scriptFirstUse(): void {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(VOLUME_PROBE, { stdout: '' });
      runner.answer(API_CONTAINERS, { stdout: '' });
    }

    it('treats a host with no container and no data volume as first use, and starts Postgres for it', async () => {
      scriptFirstUse();
      publication = FRESH;

      assert.deepEqual(await operations().readPublication(request), FRESH);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', VOLUME_PROBE, API_CONTAINERS,
        'up -d --no-build postgres', 'ps -a --format json postgres']);
    });

    it('lets a volume listing that failed through, rather than reading it as a host with no database', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' });
      runner.answer(VOLUME_PROBE, { code: 1, stderr: 'Cannot connect to the Docker daemon.' });

      await assert.rejects(operations().readPublication(request), /volume/i);
      assert.equal(runner.seen.includes('up -d --no-build postgres'), false, 'nothing was started on a guess');
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
      publication = CURRENT;

      await assert.rejects(operations().readPublication(request), /empty/i);
    });

    it('starts a stopped Postgres that still has its data volume, and never calls that revision zero', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(VOLUME_PROBE, { stdout: `${POSTGRES_VOLUME}\n` });

      assert.deepEqual(await operations().readPublication(request), CURRENT);
      assert.deepEqual(runner.seen, ['ps -a --format json postgres', VOLUME_PROBE,
        'up -d --no-build postgres', 'ps -a --format json postgres']);
    });

    it('refuses a host that has an api container but no data volume, and says what it found', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' });
      runner.answer(VOLUME_PROBE, { stdout: '' });
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
      runner.answer(VOLUME_PROBE, { stdout: `${POSTGRES_VOLUME}\n` });
      publication = CURRENT;

      await assert.rejects(operations({ firstUse: true }).readPublication(request), /empty/i);
    });

    it('reads a fresh schema through the first use the deploy decided', async () => {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(VOLUME_PROBE, { stdout: `${POSTGRES_VOLUME}\n` });
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

  describe('migrating', () => {
    it('migrates the database, which is safe because the old api is stopped by now', async () => {
      await operations().migrate(request);

      assert.deepEqual(steps, ['migrate']);
      assert.equal(migrated, 1);
    });
  });

  describe('waiting for the bundled build the api starts at boot', () => {
    it('answers the build once the row is on the pinned commit', async () => {
      const outcome = await operations().awaitBundledBuild(request);

      assert.deepEqual(outcome, { state: 'ready', commit: PIN, buildId: PIN, problem: null });
    });

    it('waits through the build the api is still running', async () => {
      bundledStates = [bundledRow({ status: 'building', layout: 'legacy', commitSha: null, buildId: null }), bundledRow()];

      const outcome = await operations().awaitBundledBuild(request);

      assert.equal(outcome.state, 'ready');
      assert.ok(steps.filter((step) => step === 'read-bundled').length >= 2, 'it asked again');
    });

    it('answers a build that failed with what the row says went wrong', async () => {
      bundledStates = [bundledRow({ status: 'failed', layout: 'legacy', commitSha: null, buildId: null, lastError: 'could not reach github' })];

      const outcome = await operations().awaitBundledBuild(request);

      assert.deepEqual(outcome, { state: 'failed', commit: PIN, buildId: null, problem: 'could not reach github' });
    });

    it('answers a rebuild that failed over a build the version keeps', async () => {
      bundledStates = [bundledRow({ commitSha: 'b'.repeat(40), buildId: 'b'.repeat(40), lastError: 'the build exited with code 1' })];

      const outcome = await operations().awaitBundledBuild(request);

      assert.equal(outcome.state, 'failed');
      assert.equal(outcome.problem, 'the build exited with code 1');
    });

    it('gives up after its own bound, saying which commit it waited for', async () => {
      bundledStates = [bundledRow({ status: 'building', layout: 'legacy', commitSha: null, buildId: null })];

      const outcome = await operations().awaitBundledBuild(request);

      assert.equal(outcome.state, 'timed-out');
      assert.equal(outcome.commit, PIN);
    });

    it('waits for nothing on a manager that pins no commit', async () => {
      await rm(join(root, 'manager', '.stack-commit'));

      const outcome = await operations().awaitBundledBuild(request);

      assert.deepEqual(outcome, { state: 'unpinned', commit: null, buildId: null, problem: null });
      assert.deepEqual(steps, [], 'and asks the database nothing');
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
    const INSPECT_API = `docker inspect --format {{.Image}} ${API_CONTAINER}`;

    /** The api container the project brought up, running the image this upgrade built. */
    function scriptApiOfThisUpgrade(): void {
      runner.answer('ps -q api', { stdout: `${API_CONTAINER}\n` });
      runner.answer(INSPECT_API, { stdout: `${IMAGE_ID}\n` });
    }

    it('waits for the api to answer its health check and for the edge to match the deploy', async () => {
      scriptApiOfThisUpgrade();
      runner.answer('--profile public ps -q edge', { stdout: '' });

      await operations({ health: [503, 200] }).verifyProject(request);

      assert.deepEqual(runner.seen, ['ps -q api', INSPECT_API, '--profile public ps -q edge']);
    });

    it('refuses when another deploy retagged the image between this build and this start', async () => {
      runner.answer('ps -q api', { stdout: `${API_CONTAINER}\n` });
      runner.answer(INSPECT_API, { stdout: `sha256:${'9'.repeat(64)}\n` });

      await assert.rejects(operations().verifyProject(request), (error: Error) => {
        assert.match(error.message, /image/i);
        assert.ok(error.message.includes(IMAGE_ID), 'the image this upgrade built is named');
        return true;
      });
    });

    it('refuses when nothing of the api service is running although it answered', async () => {
      runner.answer('ps -q api', { stdout: '' });

      await assert.rejects(operations().verifyProject(request), /api/i);
    });

    it('refuses when the api never answers, naming the address it kept asking', async () => {
      await assert.rejects(operations({ health: [503] }).verifyProject(request), (error: Error) => {
        assert.match(error.message, new RegExp(HEALTH_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      });
    });

    it('refuses when the edge is running and the deploy did not ask for it', async () => {
      scriptApiOfThisUpgrade();
      runner.answer('--profile public ps -q edge', { stdout: 'deadbeef\n' });

      await assert.rejects(operations().verifyProject(request), /edge/i);
    });

    it('refuses when the deploy asked for the edge and it is not running', async () => {
      scriptApiOfThisUpgrade();
      runner.answer('--profile public ps -q edge', { stdout: '' });

      await assert.rejects(operations({ publicEdge: true }).verifyProject(request), /edge/i);
    });
  });

  it('takes the status of a health answer and lets go of its body instead of reading it', async () => {
    let cancelled = false;
    let close!: () => void;
    // A body with a chunk in it that never ends, so reading it to the end never returns.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"status":"ok"}'));
        close = () => controller.close();
      },
      cancel: () => { cancelled = true; },
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      assert.deepEqual(await bounded(httpHealthProbe(HEALTH_URL)), { status: 200 });
    } finally {
      globalThis.fetch = original;
      if (!cancelled) close();
    }

    assert.equal(cancelled, true, 'the answer body is never read into this process');
  });

  describe('one whole run of it', () => {
    /** Everything the host answers a run on a machine that has never had the manager on it. */
    function scriptFirstUseRun(): void {
      runner.answer('ps -a --format json postgres', { stdout: '' }, { stdout: containers('running', 'healthy') });
      runner.answer(VOLUME_PROBE, { stdout: '' });
      runner.answer(API_CONTAINERS, { stdout: '' });
      runner.answer('ps -q api', { stdout: '' }, { stdout: `${API_CONTAINER}\n` });
      runner.answer(`docker inspect --format {{.Image}} ${API_CONTAINER}`, { stdout: `${IMAGE_ID}\n` });
      runner.answer('--profile public ps -q edge', { stdout: '' });
    }

    it('finishes a first use run, whose own migration turns the empty schema into the current one', async () => {
      scriptFirstUseRun();
      // Only the read before the migration can find an empty database, and this run does the migrating.
      readPublication = async () => (migrated > 0 ? CURRENT : FRESH);
      const mutableRoot = join(root, 'manager');

      const result = await runManagerUpgrade(
        { guardRoot: managerUpgradeGuardRootFor(versionsRoot), mutableRoot }, request, operations({ firstUse: true }),
      );

      assert.equal(result.state, 'completed');
      assert.deepEqual(result.bundled, { state: 'ready', commit: PIN, buildId: PIN, problem: null });
      assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'and holds nothing afterwards');
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
