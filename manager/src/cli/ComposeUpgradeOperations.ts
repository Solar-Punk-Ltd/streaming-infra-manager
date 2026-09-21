import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { readBundledPin } from '../domain/versions/bundledCommit.js';
import { deploysBuildOf } from '../domain/versions/stackPaths.js';
import type {
  BundledBuildOutcome,
  ManagerPublication,
  ManagerUpgradeOperations,
  ManagerUpgradeRequest,
} from '../domain/versions/ManagerUpgrade.js';
import type { CommandResult, CommandRunner } from './commandRunner.js';
import type { BundledVersionState, ManagerUpgradeDatabase } from './managerUpgradeDatabase.js';

/** The status of one plain GET. Nothing else about the response is used. */
export type HealthProbe = (url: string) => Promise<{ status: number }>;

export interface ComposeUpgradeTimeouts {
  /** How long any one Compose command may take. */
  command?: number;
  postgresReady?: number;
  apiHealthy?: number;
  /** How long the api's own boot may take to build the pinned stack commit. */
  bundledBuild?: number;
  pollPause?: number;
}

export interface ComposeUpgradeSettings {
  versionsRoot: string;
  composeFile: string;
  /** The tree the manager ships with, whose parent holds the commit it pins. */
  bundledStackRoot: string;
  /** Whether this deploy asked for the public HTTPS edge. */
  publicEdge: boolean;
  /**
   * Whether the deploy found a host that has never run the manager.
   *
   * Decided on the host before this upgrade's own container existed, because
   * preparing that container can create the project's volumes, and a probe
   * from inside it would then see a data volume nothing has ever written to.
   */
  firstUse: boolean;
  /** The database volume of this project, without the project name Compose prefixes it with. */
  postgresVolume: string;
  /** Where the new api answers inside the project network. */
  apiHealthUrl: string;
  timeouts?: ComposeUpgradeTimeouts;
}

/** How long the upgrade waits for the api's boot to build the pinned commit, unless the deploy says otherwise. */
export const DEFAULT_BUNDLED_BUILD_MS = 1_200_000;

const DEFAULT_TIMEOUTS: Required<ComposeUpgradeTimeouts> = {
  command: 300_000,
  postgresReady: 120_000,
  apiHealthy: 90_000,
  bundledBuild: DEFAULT_BUNDLED_BUILD_MS,
  pollPause: 2_000,
};

export const API_SERVICE = 'api';
const POSTGRES_SERVICE = 'postgres';
const EDGE_SERVICE = 'edge';
const PUBLIC_PROFILE = ['--profile', 'public'];
const HEALTHY = 'healthy';
const RUNNING = 'running';
const PROBE_TIMEOUT_MS = 10_000;
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
/** Compose sets this to True on the container a `docker compose run` starts. */
const COMPOSE_ONE_OFF_LABEL = 'com.docker.compose.oneoff';

interface ServiceContainer {
  state: string;
  health: string;
}

/** Compose lists every container of a service, so a stopped one may come first. */
function someContainerIsHealthy(containers: readonly ServiceContainer[]): boolean {
  return containers.some((container) => container.state === RUNNING && container.health === HEALTHY);
}

/** Compose prints one JSON object per line, and older versions print one array. */
function parseServiceContainers(stdout: string): ServiceContainer[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw new Error('The container listing of this Compose project could not be read as JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('The container listing of this Compose project is not a list.');
  return parsed.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return { state: String(record.State ?? '').toLowerCase(), health: String(record.Health ?? '').toLowerCase() };
  });
}

function idsOf(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Why a command failed, in the only terms that are safe to write down.
 *
 * What a failing Compose command prints can be the resolved configuration of
 * the project, which carries the database password inside DATABASE_URL, so
 * none of its output belongs in a deploy log a person pastes into a message.
 */
function commandFailure(what: string, project: string, program: string, result: CommandResult, timeoutMs: number): string {
  const outcome = result.killed
    ? `It was killed after ${Math.round(timeoutMs / 1000)} seconds.`
    : `It exited with ${result.code}.`;
  return `"${what}" failed on the ${project} project. ${outcome} Run the same ${program} command on the host to see its output.`;
}

/**
 * What the bundled row says about the pinned commit, or null while it is still
 * being built.
 *
 * Ready is the same question boot asks: does the row deploy from a complete
 * build of this commit. Failed needs the row to have moved since this upgrade
 * started the new api, because `ensureBundledBuild` can throw before it marks
 * the row as building, and the boot that swallows that leaves the error of an
 * earlier one standing.
 */
function outcomeOf(bundled: BundledVersionState | null, commit: string, before: BundledVersionState | null | undefined): BundledBuildOutcome | null {
  if (!bundled) return { state: 'failed', commit, buildId: null, problem: 'this database holds no bundled version row' };
  if (deploysBuildOf(bundled, commit)) {
    return { state: 'ready', commit, buildId: bundled.buildId, problem: null };
  }
  const built = before === undefined || !isDeepStrictEqual(bundled, before);
  if (built && bundled.status !== 'building' && bundled.gitRef === commit && bundled.lastError !== null) {
    return { state: 'failed', commit, buildId: bundled.buildId, problem: bundled.lastError };
  }
  return null;
}

/** Where the api of one manager project answers, which is the port it was configured with. */
export function apiHealthUrlFor(port: number): string {
  return `http://${API_SERVICE}:${port}/health`;
}

export const httpHealthProbe: HealthProbe = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  // Only the status is wanted, so the body is let go of rather than read into this process.
  await response.body?.cancel();
  return { status: response.status };
};

/**
 * What one manager upgrade does to the host, as Compose commands against one
 * project.
 *
 * Nothing of the streaming stack is installed here. The deploy has copied the
 * manager's own files and built the image, and the commit the manager pins is
 * fetched and built by the api itself once it is up, which is what the last
 * step waits for.
 */
export class ComposeUpgradeOperations implements ManagerUpgradeOperations {
  private readonly timeouts: Required<ComposeUpgradeTimeouts>;
  /** The bundled row before this upgrade started the api, or undefined when it has not started it. */
  private bundledBeforeStart: BundledVersionState | null | undefined;

  constructor(
    private readonly settings: ComposeUpgradeSettings,
    private readonly database: ManagerUpgradeDatabase,
    private readonly run: CommandRunner,
    private readonly probe: HealthProbe = httpHealthProbe,
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...settings.timeouts };
  }

  /**
   * The state of the schema, read before the old api is stopped, and the one
   * place a host that has never run the manager is told apart from one whose
   * database went missing. Only this read can answer that, because the
   * migration below it turns an empty schema into the current one.
   */
  async readPublication(request: ManagerUpgradeRequest): Promise<ManagerPublication> {
    const firstUse = await this.startPostgres(request.project);
    const publication = await this.database.readPublication();
    if (firstUse && publication.schema !== 'fresh') {
      throw new Error('This host has no manager database volume, so its database should be empty, and it is not. Look at the host before deploying again.');
    }
    return publication;
  }

  async stopApi(request: ManagerUpgradeRequest): Promise<void> {
    await this.compose(request.project, ['stop', API_SERVICE]);
    const running = await this.containerIds(request.project, ['ps', '-q', API_SERVICE]);
    if (running.length > 0) throw new Error('An api container is still running after it was stopped, so this upgrade cannot go on.');
  }

  async migrate(): Promise<void> {
    // The old api is stopped by now, which is the rule: no migration ever runs under it.
    await this.database.migrate();
  }

  /**
   * Waits for the api's own boot to build the stack commit this manager pins.
   *
   * The build is the api's, not this command's, so what is watched is the
   * bundled version row. It is ready when the row deploys from a build of the
   * pin, and failed when the row was moved onto the pin and carries the reason
   * a build of it did not finish. Neither is thrown: the manager is up by now,
   * and the caller decides what a failure is worth.
   */
  async awaitBundledBuild(): Promise<BundledBuildOutcome> {
    const commit = readBundledPin(this.settings.bundledStackRoot);
    if (!commit) return { state: 'unpinned', commit: null, buildId: null, problem: null };
    const deadline = Date.now() + this.timeouts.bundledBuild;
    for (;;) {
      const bundled = await this.database.readBundledVersion();
      const outcome = outcomeOf(bundled, commit, this.bundledBeforeStart);
      if (outcome) return outcome;
      if (Date.now() >= deadline) {
        return { state: 'timed-out', commit, buildId: bundled?.buildId ?? null, problem: bundled?.lastError ?? null };
      }
      await sleep(this.timeouts.pollPause);
    }
  }

  async startProject(request: ManagerUpgradeRequest): Promise<void> {
    // The row as it stands before the new api exists. Anything it says after
    // this is the boot this upgrade started, and anything it still says is an
    // earlier one's.
    this.bundledBeforeStart = await this.database.readBundledVersion();
    if (this.settings.publicEdge) {
      await this.compose(request.project, [...PUBLIC_PROFILE, 'up', '-d', '--no-build', '--remove-orphans']);
      return;
    }
    await this.compose(request.project, ['up', '-d', '--no-build', '--remove-orphans']);
    // Dropping a profile does not stop a container already running under it, so the edge goes by name.
    await this.compose(request.project, [...PUBLIC_PROFILE, 'rm', '-sf', EDGE_SERVICE]);
    if (await this.edgeIsRunning(request.project)) {
      throw new Error('MANAGER_DOMAIN is empty and the edge is still running, so the host is still answering on 80 and 443. Stop it by hand before deploying again.');
    }
  }

  async verifyProject(request: ManagerUpgradeRequest): Promise<void> {
    await this.waitForApi();
    await this.assertApiRunsTheBuiltImage(request);
    const running = await this.edgeIsRunning(request.project);
    if (running !== this.settings.publicEdge) {
      throw new Error(running
        ? 'The public edge is running although this deploy set no domain, so the host is answering on 80 and 443.'
        : 'This deploy set a domain but the public edge is not running, so the host is not answering on 443.');
    }
  }

  /**
   * That what answered the health check is a container of the image this
   * upgrade built.
   *
   * Two deploys running over each other can retag `manager-api` between one of
   * them building it and starting the project, and the one that then finds a
   * healthy api would report a manager it never built. A refusal here keeps
   * the guard held, which is what stops the next deploy until a person looks.
   */
  private async assertApiRunsTheBuiltImage(request: ManagerUpgradeRequest): Promise<void> {
    const [container] = await this.containerIds(request.project, ['ps', '-q', API_SERVICE]);
    if (!container) {
      throw new Error(`Something answered the health check but no ${API_SERVICE} container of the ${request.project} project is running, so what answered cannot be checked.`);
    }
    const argv = ['docker', 'inspect', '--format', '{{.Image}}', container];
    const result = await this.run(argv, { timeoutMs: this.timeouts.command });
    if (result.code !== 0) {
      throw new Error(commandFailure(`inspect ${API_SERVICE}`, request.project, 'docker', result, this.timeouts.command));
    }
    const image = result.stdout.trim();
    if (image !== request.manager.imageId) {
      throw new Error(`The ${API_SERVICE} container that came up runs image ${image} and this upgrade built ${request.manager.imageId}, so another deploy retagged it in between. Look at the host before deploying again.`);
    }
  }

  private composeArgv(project: string, args: readonly string[]): string[] {
    return ['docker', 'compose', '-p', project, '-f', this.settings.composeFile,
      '--project-directory', dirname(this.settings.composeFile), ...args];
  }

  private async compose(project: string, args: readonly string[]): Promise<CommandResult> {
    const argv = this.composeArgv(project, args);
    const result = await this.run(argv, { timeoutMs: this.timeouts.command });
    if (result.code !== 0) {
      throw new Error(commandFailure(args.join(' '), project, 'docker compose', result, this.timeouts.command));
    }
    return result;
  }

  private async containerIds(project: string, args: readonly string[]): Promise<string[]> {
    const result = await this.compose(project, args);
    return idsOf(result.stdout);
  }

  /**
   * The containers one service of this project has, whether they run or not.
   *
   * Asked of Docker with a label filter rather than of Compose, because
   * `docker compose ps -a` counts the one-off container the deploy runs this
   * upgrade in. A host that has never run the manager would otherwise look
   * like one that already has an api container.
   */
  private async serviceContainerIds(project: string, service: string): Promise<string[]> {
    const argv = ['docker', 'ps', '-aq',
      '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`,
      '--filter', `label=${COMPOSE_SERVICE_LABEL}=${service}`,
      '--filter', `label=${COMPOSE_ONE_OFF_LABEL}=False`];
    const result = await this.run(argv, { timeoutMs: this.timeouts.command });
    if (result.code !== 0) {
      throw new Error(commandFailure(`ps -aq ${service}`, project, 'docker', result, this.timeouts.command));
    }
    return idsOf(result.stdout);
  }

  private async serviceContainers(project: string, service: string): Promise<ServiceContainer[]> {
    const result = await this.compose(project, ['ps', '-a', '--format', 'json', service]);
    return parseServiceContainers(result.stdout);
  }

  private edgeIsRunning(project: string): Promise<boolean> {
    return this.containerIds(project, [...PUBLIC_PROFILE, 'ps', '-q', EDGE_SERVICE]).then((ids) => ids.length > 0);
  }

  /**
   * Whether the project's database volume is there.
   *
   * Read from a listing rather than from an inspection, because an inspection
   * answers the same non zero exit for a volume that is not there and for a
   * daemon that could not be asked, and calling the second one an empty host
   * is how a database gets treated as new.
   */
  private async hasPostgresVolume(project: string): Promise<boolean> {
    const name = `${project}_${this.settings.postgresVolume}`;
    const argv = ['docker', 'volume', 'ls', '-q', '--filter', `name=^${name}$`];
    const result = await this.run(argv, { timeoutMs: this.timeouts.command });
    if (result.code !== 0) {
      throw new Error(commandFailure(`volume ls ${name}`, project, 'docker', result, this.timeouts.command));
    }
    return idsOf(result.stdout).length > 0;
  }

  /**
   * Brings the database up far enough to be read, and answers whether this
   * host has never run the manager before. A host with no data volume and no
   * api container is new, and only there is an empty schema believable.
   *
   * A database that is not up yet is asked about before it is started, whether
   * it has a container of its own or not, because Compose starts one against a
   * volume it creates on the spot and an empty database that arrived that way
   * looks exactly like a host that never had one.
   */
  private async startPostgres(project: string): Promise<boolean> {
    const containers = await this.serviceContainers(project, POSTGRES_SERVICE);
    if (someContainerIsHealthy(containers)) return this.settings.firstUse;
    const hasVolume = await this.hasPostgresVolume(project);
    if (!hasVolume) {
      const api = await this.serviceContainerIds(project, API_SERVICE);
      if (api.length > 0) {
        throw new Error(`This host has an ${API_SERVICE} container but no ${project}_${this.settings.postgresVolume} volume, so its database was removed under a manager that is still installed. Look at the host before deploying again.`);
      }
    }
    await this.compose(project, ['up', '-d', '--no-build', POSTGRES_SERVICE]);
    await this.waitForHealthyPostgres(project);
    return this.settings.firstUse || !hasVolume;
  }

  private async waitForHealthyPostgres(project: string): Promise<void> {
    const deadline = Date.now() + this.timeouts.postgresReady;
    for (;;) {
      if (someContainerIsHealthy(await this.serviceContainers(project, POSTGRES_SERVICE))) return;
      if (Date.now() >= deadline) {
        throw new Error(`The ${POSTGRES_SERVICE} container of the ${project} project did not become healthy in ${Math.round(this.timeouts.postgresReady / 1000)} seconds.`);
      }
      await sleep(this.timeouts.pollPause);
    }
  }

  private async waitForApi(): Promise<void> {
    const deadline = Date.now() + this.timeouts.apiHealthy;
    let lastProblem = '';
    for (;;) {
      try {
        const { status } = await this.probe(this.settings.apiHealthUrl);
        if (status === 200) return;
        lastProblem = `It answered ${status}.`;
      } catch (error) {
        lastProblem = (error as Error).message;
      }
      if (Date.now() >= deadline) {
        throw new Error(`The new api did not answer ${this.settings.apiHealthUrl} within ${Math.round(this.timeouts.apiHealthy / 1000)} seconds. ${lastProblem}`);
      }
      await sleep(this.timeouts.pollPause);
    }
  }
}
