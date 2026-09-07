import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
  type BuildManifest,
  readBuildManifest,
} from './buildManifest.js';
import {
  adoptHostConfig,
  captureHostConfig,
  commitHostConfig,
  envKeysIn,
} from './hostConfigCapture.js';
import { readStackContract } from './stackContract.js';
import {
  buildDirFor,
  buildsRootFor,
  configRootFor,
  repoRootFor,
  stagingDirFor,
  versionRootFor,
} from './stackPaths.js';
import type {
  PublishOutcome,
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

/** The image and the package manager the build script builds with. The script's test keeps the two in step. */
export const BUILD_IMAGE = 'node:22-alpine';
export const PINNED_PNPM = 'pnpm@9.12.0';
const BUILD_TOOLCHAIN = `${BUILD_IMAGE} ${PINNED_PNPM}`;

/** What the build script leaves in the staging directory: the commit it exported. */
export const STACK_COMMIT_FILE = '.stack-commit';

/** The name the build script gives its container, so boot can tell a live builder from a dead one. */
export const BUILD_CONTAINER_PREFIX = 'stack-build-';

const STAGING_PREFIX = 'tmp-';
const BUILDS_SUFFIX = '.builds';
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** The samples a build ships and the host-owned files seeded from them when the version has none yet. */
const CONFIG_SEEDS: readonly { sample: string; live: string }[] = [
  { sample: '.env.sample', live: '.env' },
  { sample: 'deploy/config.sample.json', live: 'deploy/config.json' },
];

/** Whether a build container still runs, asked of Docker at boot. */
export interface BuildAttemptFence {
  containerExists(name: string): Promise<boolean>;
}

export interface InterruptedAttempts {
  removed: string[];
  kept: string[];
}

/** What an attempt made current: the build, published or adopted. */
interface PublishedBuild extends PublishOutcome {
  reused: boolean;
}

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

      const version = await this.versions.insert({
        name,
        gitRef: ref,
        rootPath: configRootFor(this.versionsRoot, name),
      });
      return this.startBuild(version);
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

      const building = await this.versions.markBuilding(id);
      return this.startBuild(building ?? version);
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

  /**
   * One attempt: its own staging directory and its own build container name,
   * so an attempt a gone manager left behind can be told from a live one and
   * never shares a path with the next.
   */
  private startBuild(version: StackVersionRecord): StackBuild {
    this.buildingName = version.name;
    const attempt = randomBytes(6).toString('hex');
    const repo = repoRootFor(this.versionsRoot, version.name);
    const staging = stagingDirFor(this.versionsRoot, version.name, attempt);
    logger.info(
      `[Versions] building ${version.name} from ${version.gitRef}, attempt ${attempt}, in ${staging}`,
    );

    const handle = this.runner.run(BUILD_SCRIPT, [
      repo,
      staging,
      version.gitRef,
      STACK_REPO_URL,
      attempt,
    ]);

    let log = '';
    let settled = false;
    const keepTail = (chunk: string): void => {
      log = (log + chunk).slice(-LOG_TAIL_BYTES);
    };
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      void this.finishBuild(version, attempt, code, log);
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

  /**
   * Publishes what the attempt built, or records why it could not. A version
   * that already has a usable build keeps it, ready, with the reason. Only a
   * version with nothing to deploy from is failed. The staging directory
   * goes either way.
   */
  private async finishBuild(
    version: StackVersionRecord,
    attempt: string,
    code: number,
    log: string,
  ): Promise<void> {
    this.buildingName = null;
    const staging = stagingDirFor(this.versionsRoot, version.name, attempt);
    let outcome: PublishedBuild | null = null;
    let failure: string | null = null;
    try {
      if (code !== 0) {
        throw new Error(log.trim() || `the build exited with code ${code}`);
      }
      outcome = await this.publishStaging(version, staging);
    } catch (err) {
      failure = getErrorMessage(err);
    }
    // Before the row says anything, so a reader that sees the outcome finds
    // the builds directory as the outcome describes it.
    await rm(staging, { recursive: true, force: true });

    try {
      if (outcome) {
        await this.versions.publish(version.id, outcome);
        logger.info(
          `[Versions] ${version.name} is ready on build ${outcome.buildId}${outcome.reused ? ', the complete build it already had' : ''}`,
        );
      } else {
        const current = await this.versions.findById(version.id);
        if (current?.buildId) {
          await this.versions.markUpdateFailed(
            version.id,
            `${failure} (attempt ${attempt}, ${new Date().toISOString()}). Still on build ${current.buildId}.`,
          );
        } else {
          await this.versions.markFailed(version.id, failure ?? 'the build did not publish');
        }
        logger.warn(`[Versions] ${version.name} attempt ${attempt} did not publish: ${failure}`);
      }
    } catch (writeErr) {
      logger.error(`[Versions] could not record the outcome of ${version.name}: ${getErrorMessage(writeErr)}`);
    }
    this.publishChanged();
  }

  /**
   * The staging directory becomes a build: the host configuration is captured
   * and copied in, the manifest and the complete marker are written, and the
   * directory is renamed into place under its identity. A complete build of
   * the same commit and the same inputs is adopted instead, untouched. Then
   * one row update makes it current.
   */
  private async publishStaging(
    version: StackVersionRecord,
    staging: string,
  ): Promise<PublishedBuild> {
    const commitPath = join(staging, STACK_COMMIT_FILE);
    if (!existsSync(commitPath)) {
      throw new Error(`the build left no ${STACK_COMMIT_FILE} in ${staging}, so its commit is unknown`);
    }
    const commit = (await readFile(commitPath, 'utf8')).trim().toLowerCase();
    if (!COMMIT_RE.test(commit)) {
      throw new Error(`${STACK_COMMIT_FILE} in ${staging} does not hold a commit`);
    }
    const contract = readStackContract(staging);

    const configRoot = version.rootPath ?? configRootFor(this.versionsRoot, version.name);
    await this.seedHostConfig(configRoot, staging);
    const capture = await captureHostConfig(configRoot, {
      sampleEnvKeys: await sampledEnvKeys(staging),
    });
    if (capture.problem !== null) throw new Error(capture.problem);
    const inputs = capture.captured;

    const buildsRoot = buildsRootFor(this.versionsRoot, version.name);
    await mkdir(buildsRoot, { recursive: true });
    const existing = await this.completeBuildOf(version.name, commit, inputs.generation);
    if (existing) {
      return { buildId: existing.buildId, commitSha: commit, contract, reused: true };
    }

    for (const [relative, bytes] of inputs.files) {
      await mkdir(dirname(join(staging, relative)), { recursive: true });
      await writeFile(join(staging, relative), bytes);
    }
    const buildId = await this.freeBuildId(version.name, commit);
    const manifest: BuildManifest = {
      commit,
      buildId,
      builtAt: new Date().toISOString(),
      toolchain: BUILD_TOOLCHAIN,
      inputGeneration: inputs.generation,
      inputHashes: inputs.hashes,
    };
    await writeFile(join(staging, BUILD_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(staging, BUILD_COMPLETE_MARKER), '');
    await rename(staging, buildDirFor(this.versionsRoot, version.name, buildId));
    return { buildId, commitSha: commit, contract, reused: false };
  }

  /**
   * The host-owned inputs a version starts with: the samples the build ships,
   * committed as generation one when the version has none of its own yet, so
   * an added version deploys with the stack's defaults the way it always did.
   * A root that has the files but no manifest is adopted as it stands.
   */
  private async seedHostConfig(configRoot: string, staging: string): Promise<void> {
    await mkdir(configRoot, { recursive: true });
    const seeds: Record<string, Buffer> = {};
    for (const { sample, live } of CONFIG_SEEDS) {
      if (!existsSync(join(configRoot, live)) && existsSync(join(staging, sample))) {
        seeds[live] = await readFile(join(staging, sample));
      }
    }
    if (Object.keys(seeds).length > 0) {
      await commitHostConfig(configRoot, seeds);
      logger.info(`[Versions] seeded ${Object.keys(seeds).join(', ')} in ${configRoot} from the build's samples`);
      return;
    }
    const adopted = await adoptHostConfig(configRoot);
    if (adopted) {
      logger.info(`[Versions] adopted the host configuration in ${configRoot} as generation 1`);
    }
  }

  /** A complete build of this commit whose inputs are the same generation, or null. */
  private async completeBuildOf(
    name: string,
    commit: string,
    generation: number,
  ): Promise<BuildManifest | null> {
    for (const id of await this.buildIdsOf(name, commit)) {
      const read = readBuildManifest(buildDirFor(this.versionsRoot, name, id));
      if (read.manifest && read.manifest.inputGeneration === generation) return read.manifest;
    }
    return null;
  }

  /** The commit itself when nothing is published under it, else the next `<commit>-r<n>`. Files under a published path are never replaced. */
  private async freeBuildId(name: string, commit: string): Promise<string> {
    const taken = await this.buildIdsOf(name, commit);
    if (taken.length === 0) return commit;
    const highest = taken.reduce((max, id) => {
      const match = /-r([1-9][0-9]*)$/.exec(id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${commit}-r${highest + 1}`;
  }

  private async buildIdsOf(name: string, commit: string): Promise<string[]> {
    const buildsRoot = buildsRootFor(this.versionsRoot, name);
    if (!existsSync(buildsRoot)) return [];
    return (await readdir(buildsRoot)).filter((entry) => entry === commit || entry.startsWith(`${commit}-r`));
  }

  /**
   * What boot does with the staging directories of attempts a gone manager
   * left: an attempt whose build container still runs keeps its directory,
   * because the container is still writing into it, and any other is removed.
   * A container Docker cannot be asked about counts as present, so an
   * inspection failure never deletes a directory a builder may still use.
   */
  async cleanInterruptedAttempts(fence: BuildAttemptFence): Promise<InterruptedAttempts> {
    const outcome: InterruptedAttempts = { removed: [], kept: [] };
    if (!existsSync(this.versionsRoot)) return outcome;
    for (const entry of (await readdir(this.versionsRoot)).sort()) {
      if (!entry.endsWith(BUILDS_SUFFIX)) continue;
      const name = entry.slice(0, -BUILDS_SUFFIX.length);
      const buildsRoot = join(this.versionsRoot, entry);
      for (const child of (await readdir(buildsRoot)).sort()) {
        if (!child.startsWith(STAGING_PREFIX)) continue;
        const attempt = child.slice(STAGING_PREFIX.length);
        const label = `${name}/${child}`;
        let live = true;
        try {
          live = await fence.containerExists(`${BUILD_CONTAINER_PREFIX}${attempt}`);
        } catch (err) {
          logger.warn(`[Versions] could not ask Docker about ${BUILD_CONTAINER_PREFIX}${attempt}: ${getErrorMessage(err)}. Keeping ${label}.`);
        }
        if (live) {
          outcome.kept.push(label);
          continue;
        }
        await rm(join(buildsRoot, child), { recursive: true, force: true });
        outcome.removed.push(label);
      }
    }
    if (outcome.removed.length > 0 || outcome.kept.length > 0) {
      logger.info(`[Versions] build attempts at boot: removed ${outcome.removed.join(', ') || 'none'}, kept ${outcome.kept.join(', ') || 'none'}`);
    }
    return outcome;
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

    // The flat root, the clone and every build: all three are the version's.
    for (const dir of [
      expected,
      repoRootFor(this.versionsRoot, version.name),
      buildsRootFor(this.versionsRoot, version.name),
    ]) {
      try {
        await rm(dir, { recursive: true, force: true });
        logger.info(`[Versions] removed ${dir}`);
      } catch (err) {
        logger.warn(
          `[Versions] could not delete ${dir}: ${getErrorMessage(err)}. The version is gone from the table, so remove that directory by hand.`,
        );
      }
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

/** The keys the build's .env.sample assigns, which the base env must carry. */
async function sampledEnvKeys(staging: string): Promise<string[]> {
  const sample = join(staging, '.env.sample');
  if (!existsSync(sample)) return [];
  return [...envKeysIn(await readFile(sample, 'utf8'))];
}
