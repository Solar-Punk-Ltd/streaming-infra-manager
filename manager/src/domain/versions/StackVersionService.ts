import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_VERSION_NAME,
  getErrorMessage,
  stackRefProblem,
  stackVersionNameProblem,
  type StackVersion,
} from '@streaming-infra-manager/common';

import {
  BundledVersionError,
  DefaultVersionError,
  InvalidStackVersionError,
  StackBuildBusyError,
  StackVersionExistsError,
  StackVersionInUseError,
  StackVersionNotFoundError,
  UntestedVersionError,
} from '../errors/index.js';
import { EventBus } from '../EventBus.js';
import { Logger } from '../Logger.js';
import { RunHandle, ScriptSpawner } from '../ScriptRunner.js';

import { readCheckoutCommit } from './bundledCommit.js';
import { readStackContract } from './stackContract.js';
import { versionRootFor } from './stackPaths.js';
import type {
  StackVersionRecord,
  StackVersionRepository,
} from './StackVersionRepository.js';

const logger = Logger.getInstance();

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dist/domain/versions` in the image, `src/domain/versions` under tsx. */
export const BUILD_SCRIPT = resolve(
  HERE,
  '../../../scripts/stack-version-build.sh',
);

/**
 * The one repository a version may be built from. Never operator supplied: a
 * version is a ref of the stack this manager deploys, and nothing else.
 */
export const STACK_REPO_URL =
  'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';

/** How much of the build log is kept as a failed version's reason. */
const LOG_TAIL_BYTES = 4096;

/** What a version left mid-build by a restart says when the manager comes back. */
const INTERRUPTED_BUILD =
  'Interrupted by a manager restart. Update the version to build it again.';

export interface StackBuild {
  version: StackVersionRecord;
  handle: RunHandle;
}

/**
 * The versions of the streaming stack this manager holds, and the one build at
 * a time that adds or refreshes one.
 *
 * Builds are serialised because the stack tags its images by service name
 * alone, so two checkouts building at once would overwrite each other's tags
 * and every deployment would end up on whichever half finished last. A version
 * is choosable only once its build has finished, which is what `building`
 * means, and only a ready version can become the default.
 */
export class StackVersionService {
  /** The version building right now, or null. This is the mutex. */
  private buildingName: string | null = null;

  constructor(
    private readonly versions: StackVersionRepository,
    private readonly runner: ScriptSpawner,
    private readonly eventBus: EventBus,
    private readonly versionsRoot: string,
  ) {}

  async list(): Promise<StackVersion[]> {
    const rows = await this.versions.list();
    return rows.map((row) => toApiVersion(row, row.deployments));
  }

  /**
   * Records what only the running manager can work out about the version it
   * ships with: which commit its checkout is on, and what that checkout's
   * deploy contract says. Called once at boot.
   */
  async refreshBundled(
    bundledRoot: string,
    commitSha: string | null,
  ): Promise<void> {
    const bundled = await this.versions.findByName(BUNDLED_VERSION_NAME);
    if (!bundled) return;

    await this.versions.setCommitSha(bundled.id, commitSha);
    logger.info(
      `[Versions] bundled is at ${commitSha ?? 'a commit unknown on this host'}`,
    );

    try {
      await this.versions.setContract(bundled.id, readStackContract(bundledRoot));
    } catch (err) {
      logger.warn(
        `[Versions] could not read the bundled version's contract: ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * Fails every version left `building`, and answers their names.
   *
   * A build lives in the manager process that spawned it, so a row still
   * building at boot belongs to a process that is gone. Left alone it stays
   * building forever, and a building version can be neither updated, made the
   * default nor removed. The same repair `resetOrphanedTransitions` makes for
   * the profiles a deploy was interrupted on.
   */
  async failInterruptedBuilds(): Promise<string[]> {
    const interrupted =
      await this.versions.failInterruptedBuilds(INTERRUPTED_BUILD);
    if (interrupted.length === 0) return [];

    this.publishChanged();
    return interrupted.map((version) => version.name);
  }

  async add(name: string, ref: string): Promise<StackBuild> {
    refuse(stackVersionNameProblem(name));
    refuse(stackRefProblem(ref));

    this.reserveBuild(name);
    try {
      if (await this.versions.findByName(name)) {
        throw new StackVersionExistsError(name);
      }

      const rootPath = versionRootFor(this.versionsRoot, name);
      const version = await this.versions.insert({
        name,
        gitRef: ref,
        rootPath,
      });
      return this.startBuild(version, rootPath);
    } catch (err) {
      this.buildingName = null;
      throw err;
    }
  }

  async update(id: number): Promise<StackBuild> {
    this.reserveBuild(`version ${id}`);
    try {
      const version = await this.require(id);
      if (version.name === BUNDLED_VERSION_NAME) {
        throw new BundledVersionError(
          'The bundled version comes with the manager. Deploy the manager to move it, or add another version to follow a branch.',
        );
      }

      const rootPath =
        version.rootPath ?? versionRootFor(this.versionsRoot, version.name);
      const building = await this.versions.markBuilding(id);
      return this.startBuild(building ?? version, rootPath);
    } catch (err) {
      this.buildingName = null;
      throw err;
    }
  }

  async setDefault(id: number): Promise<void> {
    const version = await this.require(id);
    if (version.status !== 'ready') {
      throw new InvalidStackVersionError(
        `${version.name} is ${version.status}. Only a version that finished building can be the default.`,
      );
    }
    if (!version.tested) {
      throw new UntestedVersionError(version.name);
    }

    await this.versions.setDefault(version.id);
    this.publishChanged();
  }

  async setTested(id: number, tested: boolean): Promise<StackVersion> {
    const version = await this.require(id);
    if (tested && version.status !== 'ready') {
      throw new InvalidStackVersionError(
        `${version.name} is ${version.status}. Only a version that finished building can be marked as tested.`,
      );
    }

    const updated = await this.versions.setTested(id, tested);
    if (!updated) throw new StackVersionNotFoundError(id);

    this.publishChanged();
    const deployments = await this.versions.deploymentNames(id);
    return toApiVersion(updated, deployments.length);
  }

  async remove(id: number): Promise<void> {
    const version = await this.require(id);
    if (version.name === BUNDLED_VERSION_NAME) {
      throw new BundledVersionError(
        'The bundled version comes with the manager and cannot be removed. Set another version as the default instead.',
      );
    }
    if (this.buildingName === version.name) {
      throw new StackBuildBusyError(version.name);
    }
    if (version.isDefault) {
      throw new DefaultVersionError(version.name);
    }

    const deployments = await this.versions.deploymentNames(id);
    if (deployments.length > 0) {
      throw new StackVersionInUseError(version.name, deployments);
    }

    // The checkout first. Deleting the row and then failing to delete the
    // files would leave about a gigabyte on the host that nothing in the
    // database names any more. The row goes either way, because the version is
    // meant to be gone, and a failed delete is a warning naming the path so it
    // can be cleared by hand.
    await this.removeCheckout(version);
    await this.versions.remove(id);
    this.publishChanged();
  }

  // ------------------------------------------------------------- the build

  /**
   * Takes the mutex, and takes it before the caller can await anything. Two
   * requests arriving together both used to read it as free, because the check
   * sat before an `await` and the setting sat after one, so both spawned a
   * build and the two overwrote each other's image tags.
   *
   * `update` books the id, because the version's name is in the row it has not
   * read yet, and `startBuild` puts the name in its place a moment later.
   */
  private reserveBuild(label: string): void {
    if (this.buildingName !== null) {
      throw new StackBuildBusyError(this.buildingName);
    }
    this.buildingName = label;
  }

  private startBuild(version: StackVersionRecord, root: string): StackBuild {
    this.buildingName = version.name;
    logger.info(
      `[Versions] building ${version.name} from ${version.gitRef} in ${root}`,
    );

    const handle = this.runner.run(BUILD_SCRIPT, [
      root,
      version.gitRef,
      STACK_REPO_URL,
    ]);

    let log = '';
    let settled = false;
    const keepTail = (chunk: string): void => {
      log = (log + chunk).slice(-LOG_TAIL_BYTES);
    };
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      void this.finishBuild(version, root, code, log);
    };

    handle.emitter.on('stdout', keepTail);
    handle.emitter.on('stderr', keepTail);
    // A script that never started emits `error` and no `done`, so the mutex and
    // the row would both be left where they are without this.
    handle.emitter.on('error', (err: Error) => {
      keepTail(err.message);
      settle(-1);
    });
    handle.emitter.on('done', ({ code }: { code: number }) => settle(code));

    return { version, handle };
  }

  private async finishBuild(
    version: StackVersionRecord,
    root: string,
    code: number,
    log: string,
  ): Promise<void> {
    this.buildingName = null;
    try {
      if (code === 0) {
        // Asked of the checkout rather than read out of the log. The script
        // prints the commit too, but a real build prints tens of thousands of
        // lines after it and only the tail of that stream is kept.
        await this.versions.markBuilt(version.id, {
          commitSha: readCheckoutCommit(root),
          contract: readStackContract(root),
        });
        logger.info(`[Versions] ${version.name} is ready`);
      } else {
        const reason = log.trim() || `the build exited with code ${code}`;
        await this.versions.markFailed(version.id, reason);
        logger.warn(`[Versions] ${version.name} failed to build: ${reason}`);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error(`[Versions] could not finish ${version.name}: ${message}`);
      await this.versions.markFailed(version.id, message).catch(() => null);
    }
    this.publishChanged();
  }

  // ---------------------------------------------------------- the plumbing

  private async require(id: number): Promise<StackVersionRecord> {
    const version = await this.versions.findById(id);
    if (!version) throw new StackVersionNotFoundError(id);
    return version;
  }

  /**
   * Deletes a removed version's checkout, and only one directly under the
   * versions root named after that version. The same shape of refusal the
   * profile data directories get, for the same reason: this ends in an `rm -rf`
   * of about a gigabyte.
   */
  private async removeCheckout(version: StackVersionRecord): Promise<void> {
    const expected = versionRootFor(this.versionsRoot, version.name);
    if (version.rootPath !== expected) {
      logger.warn(
        `[Versions] left ${version.rootPath ?? 'the bundled checkout'} in place: it is not ${expected}`,
      );
      return;
    }

    try {
      await rm(expected, { recursive: true, force: true });
      logger.info(`[Versions] removed checkout ${expected}`);
    } catch (err) {
      logger.warn(
        `[Versions] could not delete ${expected}: ${getErrorMessage(err)}. The version is gone from the table, so remove that directory by hand.`,
      );
    }
  }

  /**
   * One event for the whole table rather than one per row: the default badge,
   * every usage count and the build status move together, and the page reloads
   * the list either way.
   */
  private publishChanged(): void {
    this.eventBus.publish({ type: 'version.changed' });
  }
}

function toApiVersion(
  version: StackVersionRecord,
  deployments: number,
): StackVersion {
  return {
    id: version.id,
    name: version.name,
    gitRef: version.gitRef,
    commitSha: version.commitSha,
    status: version.status,
    isDefault: version.isDefault,
    tested: version.tested,
    builtAt: version.builtAt ? version.builtAt.toISOString() : null,
    lastError: version.lastError,
    contract: version.contract,
    deployments,
  };
}

function refuse(problem: string | null): void {
  if (problem) throw new InvalidStackVersionError(problem);
}
