import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { BundledShipmentReceipt } from '../domain/versions/BundledShipment.js';
import { BUNDLED_PACKAGE_MANIFEST, parseBundledPackageManifest } from '../domain/versions/bundledShipmentPackage.js';
import type { ManagerPublication, ManagerUpgradeOperations, ManagerUpgradeRequest } from '../domain/versions/ManagerUpgrade.js';
import { sealedBundledPackagePathFor } from '../domain/versions/stackPaths.js';
import type { CommandResult, CommandRunner } from './commandRunner.js';
import type { ManagerUpgradeDatabase } from './managerUpgradeDatabase.js';

/** The status of one plain GET. Nothing else about the response is used. */
export type HealthProbe = (url: string) => Promise<{ status: number }>;

export interface ComposeUpgradeTimeouts {
  /** How long any one Compose command may take. */
  command?: number;
  postgresReady?: number;
  apiHealthy?: number;
  pollPause?: number;
}

export interface ComposeUpgradeSettings {
  versionsRoot: string;
  composeFile: string;
  toolchain: string;
  /** Whether this deploy asked for the public HTTPS edge. */
  publicEdge: boolean;
  timeouts?: ComposeUpgradeTimeouts;
}

const DEFAULT_TIMEOUTS: Required<ComposeUpgradeTimeouts> = {
  command: 300_000,
  postgresReady: 120_000,
  apiHealthy: 90_000,
  pollPause: 2_000,
};

const API_SERVICE = 'api';
const POSTGRES_SERVICE = 'postgres';
const EDGE_SERVICE = 'edge';
const PUBLIC_PROFILE = ['--profile', 'public'];
/** The Compose volume that holds the manager's database, prefixed by the project name. */
const POSTGRES_VOLUME = 'manager-pg';
const API_HEALTH_URL = 'http://api:9876/health';
const HEALTHY = 'healthy';
const RUNNING = 'running';
const PROBE_TIMEOUT_MS = 10_000;

interface ServiceContainer {
  state: string;
  health: string;
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

export const httpHealthProbe: HealthProbe = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  await response.arrayBuffer();
  return { status: response.status };
};

/**
 * What one manager upgrade does to the host, as Compose commands against one
 * project.
 *
 * The sources are not installed here. The deploy has already copied the
 * manager's own files and built the image, and a running container takes its
 * code from its image, so the step named `installSources` checks that the
 * package the deploy shipped is the one this upgrade was told to publish and
 * copies nothing. A mismatch is a refusal before anything is published.
 */
export class ComposeUpgradeOperations implements ManagerUpgradeOperations {
  private readonly timeouts: Required<ComposeUpgradeTimeouts>;

  constructor(
    private readonly settings: ComposeUpgradeSettings,
    private readonly database: ManagerUpgradeDatabase,
    private readonly run: CommandRunner,
    private readonly probe: HealthProbe = httpHealthProbe,
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...settings.timeouts };
  }

  async readPublication(request: ManagerUpgradeRequest): Promise<ManagerPublication> {
    const firstUse = await this.startPostgres(request.project);
    const publication = await this.database.readPublication(request.shipment);
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

  async installSources(request: ManagerUpgradeRequest): Promise<void> {
    const sealed = sealedBundledPackagePathFor(this.settings.versionsRoot, request.shipment.shipmentId);
    let manifest;
    try {
      manifest = parseBundledPackageManifest(await readFile(join(sealed, BUNDLED_PACKAGE_MANIFEST)));
    } catch (error) {
      throw new Error(`The package this upgrade publishes cannot be read at ${sealed}. ${(error as Error).message}`);
    }
    if (manifest.shipmentId !== request.shipment.shipmentId || manifest.commit !== request.shipment.commit ||
      manifest.digest !== request.shipment.digest) {
      throw new Error(`The package at ${sealed} carries another identity than this upgrade was given. Its digest or its commit differs.`);
    }
  }

  async publish(request: ManagerUpgradeRequest): Promise<BundledShipmentReceipt> {
    // The old api is stopped by now, which is the rule: no migration ever runs under it.
    await this.database.migrate();
    const activation = await this.database.publishBundled({
      identity: request.shipment,
      readyPath: sealedBundledPackagePathFor(this.settings.versionsRoot, request.shipment.shipmentId),
      toolchain: this.settings.toolchain,
    });
    if (activation.status !== 'published') {
      throw new Error('A newer publication of the bundled stack won, so this upgrade published nothing. Deploy again to ship a new shipment.');
    }
    return activation.receipt;
  }

  async startProject(request: ManagerUpgradeRequest): Promise<void> {
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
    const running = await this.edgeIsRunning(request.project);
    if (running !== this.settings.publicEdge) {
      throw new Error(running
        ? 'The public edge is running although this deploy set no domain, so the host is answering on 80 and 443.'
        : 'This deploy set a domain but the public edge is not running, so the host is not answering on 443.');
    }
  }

  private composeArgv(project: string, args: readonly string[]): string[] {
    return ['docker', 'compose', '-p', project, '-f', this.settings.composeFile,
      '--project-directory', dirname(this.settings.composeFile), ...args];
  }

  private async compose(project: string, args: readonly string[]): Promise<CommandResult> {
    const argv = this.composeArgv(project, args);
    const result = await this.run(argv, { timeoutMs: this.timeouts.command });
    if (result.code !== 0) throw new Error(`"${args.join(' ')}" failed on the ${project} project. ${result.stderr.trim() || `It exited with ${result.code}.`}`);
    return result;
  }

  private async containerIds(project: string, args: readonly string[]): Promise<string[]> {
    const result = await this.compose(project, args);
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  private async serviceContainers(project: string, service: string): Promise<ServiceContainer[]> {
    const result = await this.compose(project, ['ps', '-a', '--format', 'json', service]);
    return parseServiceContainers(result.stdout);
  }

  private edgeIsRunning(project: string): Promise<boolean> {
    return this.containerIds(project, [...PUBLIC_PROFILE, 'ps', '-q', EDGE_SERVICE]).then((ids) => ids.length > 0);
  }

  private async hasPostgresVolume(project: string): Promise<boolean> {
    const result = await this.run(['docker', 'volume', 'inspect', `${project}_${POSTGRES_VOLUME}`], { timeoutMs: this.timeouts.command });
    return result.code === 0;
  }

  /**
   * Brings the database up far enough to be read, and answers whether this
   * host has never run the manager before. A host with no data volume and no
   * api container is new, and only there is an empty schema believable.
   */
  private async startPostgres(project: string): Promise<boolean> {
    const [container] = await this.serviceContainers(project, POSTGRES_SERVICE);
    if (container?.state === RUNNING && container.health === HEALTHY) return false;
    let firstUse = false;
    if (!container) {
      const hasVolume = await this.hasPostgresVolume(project);
      if (!hasVolume) {
        const api = await this.containerIds(project, ['ps', '-aq', API_SERVICE]);
        if (api.length > 0) {
          throw new Error(`This host has an ${API_SERVICE} container but no ${project}_${POSTGRES_VOLUME} volume, so its database was removed under a manager that is still installed. Look at the host before deploying again.`);
        }
      }
      firstUse = !hasVolume;
    }
    await this.compose(project, ['up', '-d', '--no-build', POSTGRES_SERVICE]);
    await this.waitForHealthyPostgres(project);
    return firstUse;
  }

  private async waitForHealthyPostgres(project: string): Promise<void> {
    const deadline = Date.now() + this.timeouts.postgresReady;
    for (;;) {
      const [container] = await this.serviceContainers(project, POSTGRES_SERVICE);
      if (container?.state === RUNNING && container.health === HEALTHY) return;
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
        const { status } = await this.probe(API_HEALTH_URL);
        if (status === 200) return;
        lastProblem = `It answered ${status}.`;
      } catch (error) {
        lastProblem = (error as Error).message;
      }
      if (Date.now() >= deadline) {
        throw new Error(`The new api did not answer ${API_HEALTH_URL} within ${Math.round(this.timeouts.apiHealthy / 1000)} seconds. ${lastProblem}`);
      }
      await sleep(this.timeouts.pollPause);
    }
  }
}
