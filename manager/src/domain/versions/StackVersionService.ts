import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  InvalidStackVersionError,
  StackBuildBusyError,
  StackVersionExistsError,
  StackVersionNotFoundError,
  UntestedVersionError,
} from '../errors/index.js';
import { EventBus } from '../EventBus.js';
import { Logger } from '../Logger.js';
import { RunHandle, ScriptSpawner } from '../ScriptRunner.js';

import type { BuildReferenceReader } from './buildLedger.js';
import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
  buildIdProblem,
  type BuildManifest,
  readBuildManifest,
} from './buildManifest.js';
import { protectedBuildIds } from './buildReferences.js';
import { persistVersionRemoval } from './versionRemovalMarker.js';
import { assertOwnedVersionParent } from './ownedVersionParent.js';
import {
  adoptHostConfig,
  captureHostConfig,
  commitHostConfig,
  envKeysIn,
  hostConfigFilesOf,
  hostConfigHash,
  readHostConfigRevision,
} from './hostConfigCapture.js';
import { readStackContract } from './stackContract.js';
import { bootstrapStackDefaults, BUNDLED_STACK_ROOT, parseBaseEnv } from '../../utils/envUtils.js';
import {
  buildDirFor,
  buildsRootFor,
  bundledIncomingRootFor,
  configRootFor,
  repoRootFor,
  stackRootOf,
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

export interface PrunedBuilds {
  removed: string[];
  kept: string[];
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
    private readonly references: BuildReferenceReader,
    /** The tree the manager ships with, what a legacy bundled row runs. */
    private bundledRoot: string = BUNDLED_STACK_ROOT,
  ) {}

  async list(): Promise<StackVersion[]> {
    const rows = await this.versions.list();
    return rows.map((row) => toApiVersion(row, row.deployments));
  }

  /**
   * What the manager's own deploy shipped, published as a build of the
   * bundled version, and what the row says otherwise. Called once at boot.
   *
   * The deploy leaves the built stack in `bundled.incoming/` under the
   * versions root, with its commit, and never writes into the tree the
   * engines mount again. A shipment is published the way an added version's
   * build is: its base env, deploy config and engine envs are committed as
   * the bundled version's host configuration when they changed, the tree
   * becomes `bundled.builds/<id>/` with manifest and marker, or a complete
   * build of the same commit and inputs is adopted and the shipment dropped,
   * and one row update makes it current, with the config root as the row's
   * root from then on. A shipment that cannot be published is left where it
   * is for a look, with the reason on the row, and the next deploy replaces
   * it.
   *
   * A row never published stays legacy on the tree the manager ships with:
   * its commit is what the deploy wrote next to that tree, and its contract
   * is read from it, as before.
   */
  async syncBundled(bundledRoot: string, legacyCommit: string | null): Promise<void> {
    this.bundledRoot = bundledRoot;
    const bundled = await this.versions.findByName(BUNDLED_VERSION_NAME);
    if (!bundled) return;

    const incoming = bundledIncomingRootFor(this.versionsRoot);
    if (existsSync(incoming)) await this.publishShipment(bundled, incoming);
    else await this.adoptOrphanedShipment(bundled);

    const current = await this.versions.findByName(BUNDLED_VERSION_NAME);
    if (!current) return;
    if (current.layout === 'builds') {
      logger.info(`[Versions] bundled deploys from build ${current.buildId ?? 'unknown'}`);
      return;
    }

    await this.versions.setCommitSha(current.id, legacyCommit);
    logger.info(
      `[Versions] bundled is at ${legacyCommit ?? 'a commit unknown on this host'}, on the tree the manager ships with`,
    );
    // A legacy host gets its defaults from the samples, as it always did.
    // Only here: once published, nothing writes into the tree the engines
    // of existing deployments mount.
    for (const file of await bootstrapStackDefaults(bundledRoot)) {
      logger.info(`[Versions] created missing default: ${file}`);
    }
    try {
      await this.versions.setContract(current.id, readStackContract(bundledRoot));
    } catch (err) {
      logger.warn(
        `[Versions] could not read the bundled version's contract: ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * The host-wide SRT passphrase, from the base env of the tree the bundled
   * version runs: the tree the manager ships with while the row is legacy,
   * and its current build once published.
   */
  async hostPassphrase(): Promise<string | null> {
    const bundled = await this.versions.findByName(BUNDLED_VERSION_NAME);
    const root = bundled && bundled.layout === 'builds' ? stackRootOf(bundled) : this.bundledRoot;
    return parseBaseEnv(root).SRT_PASSPHRASE?.trim() || null;
  }

  private async publishShipment(bundled: StackVersionRecord, incoming: string): Promise<void> {
    const configRoot = bundled.rootPath ?? configRootFor(this.versionsRoot, bundled.name);
    let outcome: PublishedBuild | null = null;
    try {
      await this.commitShippedInputs(configRoot, incoming);
      outcome = await this.publishStaging(bundled, incoming);
      if (outcome.reused) await rm(incoming, { recursive: true, force: true });
      await this.versions.publish(bundled.id, { ...outcome, rootPath: configRoot });
      logger.info(
        `[Versions] bundled is ready on build ${outcome.buildId}${outcome.reused ? ', the complete build it already had' : ''}, from the deploy's shipment`,
      );
      await this.pruneBuilds(bundled.id);
    } catch (err) {
      await this.recordShipmentFailure(bundled, incoming, outcome, getErrorMessage(err));
    }
    this.publishChanged();
  }

  /**
   * Where the shipment is after a failure, said truthfully: still in the
   * incoming directory when nothing moved it, or already renamed into the
   * builds directory when the row update after the rename is what failed,
   * in which case the next boot adopts it.
   */
  private async recordShipmentFailure(
    bundled: StackVersionRecord,
    incoming: string,
    outcome: PublishedBuild | null,
    failure: string,
  ): Promise<void> {
    const standing = bundled.buildId
      ? `Still on build ${bundled.buildId}.`
      : 'Still on the tree the manager ships with.';
    const where = outcome
      ? `The build is complete in ${buildDirFor(this.versionsRoot, bundled.name, outcome.buildId)}, and the next boot adopts it.`
      : existsSync(incoming)
        ? `The shipment is left in ${incoming} for a look, and the next deploy replaces it.`
        : 'The shipment is gone.';
    logger.warn(`[Versions] the shipped bundled stack was not published: ${failure} ${where}`);
    try {
      await this.versions.markUpdateFailed(
        bundled.id,
        `The shipped bundled stack was not published: ${failure} ${standing} ${where}`,
      );
    } catch (writeErr) {
      logger.error(`[Versions] could not record the failed bundled publication: ${getErrorMessage(writeErr)}`);
    }
  }

  /**
   * A complete bundled build the row does not name and nothing mounts is
   * the shipment a crash between its rename and the row update left behind:
   * prune would have removed anything else. The newest is adopted as the
   * current build, as the row update would have made it.
   */
  private async adoptOrphanedShipment(bundled: StackVersionRecord): Promise<void> {
    const buildsRoot = buildsRootFor(this.versionsRoot, bundled.name);
    if (!existsSync(buildsRoot)) return;
    const referenced = new Set((await this.references.openReferences(bundled.id)).map((reference) => reference.buildId));
    let newest: { buildId: string; manifest: BuildManifest } | null = null;
    for (const entry of await readdir(buildsRoot)) {
      if (buildIdProblem(entry) !== null) continue;
      if (entry === bundled.buildId || entry === bundled.previousBuildId || referenced.has(entry)) continue;
      const read = readBuildManifest(join(buildsRoot, entry));
      if (!read.manifest) continue;
      if (!newest || read.manifest.builtAt > newest.manifest.builtAt) newest = { buildId: entry, manifest: read.manifest };
    }
    if (!newest) return;
    const configRoot = bundled.rootPath ?? configRootFor(this.versionsRoot, bundled.name);
    try {
      const contract = readStackContract(join(buildsRoot, newest.buildId));
      await this.versions.publish(bundled.id, {
        buildId: newest.buildId,
        commitSha: newest.manifest.commit,
        contract,
        rootPath: configRoot,
      });
      logger.warn(
        `[Versions] bundled adopted build ${newest.buildId}, which a crash before the row update left unreferenced`,
      );
      await this.pruneBuilds(bundled.id);
      this.publishChanged();
    } catch (err) {
      logger.warn(`[Versions] could not adopt the unreferenced bundled build ${newest.buildId}: ${getErrorMessage(err)}`);
    }
  }

  /**
   * The base env, the deploy config and the engine envs the deploy shipped,
   * committed as the bundled version's host configuration when they differ
   * from what is committed, and a file of the set the shipment no longer
   * carries taken out of it. The deploy is the supported editor of these
   * files for the bundled version, so the checkout it ran from stays their
   * source of truth, and an unchanged shipment bumps no generation.
   */
  private async commitShippedInputs(configRoot: string, incoming: string): Promise<void> {
    const shipped = hostConfigFilesOf(incoming);
    const gone = hostConfigFilesOf(configRoot).filter((relative) => !shipped.includes(relative));
    if (shipped.length === 0 && gone.length === 0) return;
    const contents = await Promise.all(shipped.map((relative) => readFile(join(incoming, relative))));
    const files = Object.fromEntries(shipped.map((relative, index) => [relative, contents[index]!]));
    const committed = await readHostConfigRevision(configRoot);
    const unchanged =
      committed !== null &&
      gone.length === 0 &&
      shipped.every((relative) => committed.files[relative] === hostConfigHash(files[relative]!));
    if (unchanged) return;
    await mkdir(configRoot, { recursive: true });
    const revision = await commitHostConfig(configRoot, files, { remove: gone });
    logger.info(
      `[Versions] committed the shipped ${shipped.join(', ')}${gone.length > 0 ? `, without ${gone.join(', ')},` : ''} as bundled's host configuration, generation ${revision.generation}`,
    );
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
      if (!building) throw new StackVersionNotFoundError(id);
      return this.startBuild(building);
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
    if (this.buildingName === version.name) {
      throw new StackBuildBusyError(version.name);
    }
    const removed = await this.versions.removeGuarded(version, locked => this.removeCheckout(locked));
    if (!removed) throw new StackVersionNotFoundError(id);
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
    // the builds directory as the outcome describes it. A tree the build
    // container left owned by root is one the manager's own user cannot
    // remove, and that is a warning to act on, not a reason for the process
    // to go down with an unhandled rejection.
    try {
      await rm(staging, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[Versions] could not remove staging ${staging}: ${getErrorMessage(err)}. Remove it by hand.`,
      );
    }

    try {
      if (outcome) {
        await this.versions.publish(version.id, outcome);
        logger.info(
          `[Versions] ${version.name} is ready on build ${outcome.buildId}${outcome.reused ? ', the complete build it already had' : ''}`,
        );
        await this.pruneBuilds(version.id);
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
   * Deletes every build directory of the version that nothing protects: not
   * the current build, not the previous one, and not one an open reference
   * names, and not a registered or prepared shipment's candidate. Under the
   * version row's lock, so a claim taking its reference
   * either committed before this read or waits and reads the row as prune
   * left it. An attempt's staging directory is boot's, and the flat root,
   * which keeps the host-owned inputs, is never a build.
   */
  async pruneBuilds(versionId: number): Promise<PrunedBuilds> {
    const prune = async (): Promise<PrunedBuilds> => {
      const version = await this.versions.findById(versionId);
      const outcome: PrunedBuilds = { removed: [], kept: [] };
      if (!version || version.layout !== 'builds') return outcome;
      const buildsRoot = buildsRootFor(this.versionsRoot, version.name);
      if (!existsSync(buildsRoot)) return outcome;
      const keep = protectedBuildIds(version, await this.references.openReferences(versionId));
      for (const id of await this.references.pendingShipmentBuildIds(versionId)) keep.add(id);
      for (const entry of (await readdir(buildsRoot)).sort()) {
        if (buildIdProblem(entry) !== null) continue;
        if (keep.has(entry)) {
          outcome.kept.push(entry);
          continue;
        }
        await rm(join(buildsRoot, entry), { recursive: true, force: true });
        outcome.removed.push(entry);
      }
      if (outcome.removed.length > 0) {
        logger.info(`[Versions] pruned ${version.name}: removed ${outcome.removed.join(', ')}, kept ${outcome.kept.join(', ') || 'none'}`);
      }
      return outcome;
    };
    return this.references.lockVersion ? this.references.lockVersion(versionId, prune) : prune();
  }

  /** Prune for every version, at boot, after the containers were observed. */
  async pruneAll(): Promise<void> {
    for (const version of await this.versions.list()) {
      await this.pruneBuilds(version.id);
    }
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
    if (stackVersionNameProblem(version.name) || version.rootPath !== expected) throw new Error('Version root is not an owned version directory.');
    const directories = [
      expected,
      repoRootFor(this.versionsRoot, version.name),
      buildsRootFor(this.versionsRoot, version.name),
    ];
    if (!assertOwnedVersionParent(this.versionsRoot, true)) await mkdir(this.versionsRoot, { recursive: true });
    assertOwnedVersionParent(this.versionsRoot);
    for (const directory of directories) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Owned version directory is a symbolic link or is not a directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await persistVersionRemoval(version);
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
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
    layout: version.layout,
    buildId: version.buildId,
    previousBuildId: version.previousBuildId,
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
