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
  type StackSettings,
  type StackSettingsApplied,
  type StackSettingsSave,
  type StackSettingsSaved,
  type StackVersion,
} from '@streaming-infra-manager/common';

import {
  BundledVersionError,
  InvalidStackVersionError,
  StackBuildBusyError,
  StackSettingsNotReadyError,
  StackVersionChangedError,
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
import { cloneBuildTree, type BuildTreeSharing } from './buildTreeClone.js';
import { persistVersionRemoval } from './versionRemovalMarker.js';
import { assertOwnedVersionParent } from './ownedVersionParent.js';
import {
  adoptHostConfig,
  captureHostConfig,
  envKeysIn,
  withHostConfigLock,
} from './hostConfigCapture.js';
import { bundledPinProblem, readBundledPin } from './bundledCommit.js';
import {
  completeHostConfigFromSamples,
  samplePairsIn,
  type SamplePair,
} from './hostConfigCompletion.js';
import { describeSettingsSave, saveHostConfigSettings } from './hostConfigSave.js';
import {
  readHostConfigSettings,
  readySettingsSources,
  type HostConfigSettingsSources,
} from './hostConfigSettings.js';
import { carryOverLegacyHostConfig } from './legacyHostConfig.js';
import { readStackContract } from './stackContract.js';
import { BUNDLED_STACK_ROOT, parseBaseEnv } from '../../utils/envUtils.js';
import {
  buildDirFor,
  buildsRootFor,
  configRootFor,
  deployRootProblem,
  deploysBuildOf,
  repoRootFor,
  settingsTreeOf,
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

/** The deploy config's own seed. The env files come from `samplePairsIn`, which completion walks too. */
const DEPLOY_CONFIG_SEED: SamplePair = {
  sample: 'deploy/config.sample.json',
  live: 'deploy/config.json',
};

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

/**
 * Every build's copy of a settings file, owner only.
 *
 * These are the same bytes as the config root's own files, secrets included,
 * and the api container runs as root, so a mode left to the umask is a file
 * every account on the host can read.
 */
const SETTINGS_FILE_MODE = 0o600;

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

  /** Refreshes metadata only for an explicit legacy row. A build is published
   * by the build that produced it, never by a timestamp or an incoming path. */
  async syncBundled(bundledRoot: string, legacyCommit: string | null): Promise<void> {
    this.bundledRoot = bundledRoot;
    const snapshot = await this.versions.captureLegacyMetadata();
    if (!snapshot) {
      const current = await this.versions.findByName(BUNDLED_VERSION_NAME);
      if (current?.layout === 'builds') logger.info(`[Versions] bundled deploys from build ${current.buildId ?? 'unknown'}`);
      return;
    }
    let contract: StackVersionRecord['contract'] = null;
    try { contract = readStackContract(snapshot.version.rootPath ?? bundledRoot); }
    catch { logger.warn('[Versions] legacy bundled contract could not be read. No files were changed.'); }
    if (!await this.versions.refreshLegacyMetadata(snapshot, { commitSha: legacyCommit, contract })) {
      logger.info('[Versions] bundled changed while legacy metadata was read. The newer row was preserved.');
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

  /**
   * Builds the version again. For the bundled one that means the stack commit
   * this manager pins, which is also the ref its row is moved onto, so a
   * rebuild after a manager deploy follows the new pin rather than the old one.
   */
  async update(id: number): Promise<StackBuild> {
    this.reserveBuild(`version ${id}`);
    try {
      const version = await this.require(id);
      const gitRef = version.name === BUNDLED_VERSION_NAME ? this.pinnedStackCommit() : undefined;

      const building = await this.versions.markBuilding(id, gitRef);
      if (!building) throw new StackVersionNotFoundError(id);
      return this.startBuild(building);
    } catch (err) {
      this.buildingName = null;
      throw err;
    }
  }

  /**
   * Builds the pinned stack commit when the bundled version is not already on
   * a complete build of it, which is what boot calls.
   *
   * Nothing runs when this manager pins no commit, which is a developer
   * machine: there the row stays legacy on the tree in the checkout. Nothing
   * runs either while another version is building, because one build at a time
   * is the rule and the next restart tries again. A build that fails leaves a
   * failed version row on the Versions page, and the api starts either way.
   */
  async ensureBundledBuild(): Promise<StackBuild | null> {
    const pin = readBundledPin(this.bundledRoot);
    const bundled = await this.versions.findByName(BUNDLED_VERSION_NAME);
    if (!pin) {
      const problem = bundledPinProblem(this.bundledRoot);
      if (!problem) {
        logger.info('[Versions] this manager pins no stack commit, so the bundled version stays on the tree it ships with');
        return null;
      }
      logger.warn(`[Versions] ${problem}`);
      if (bundled && bundled.buildId === null) await this.recordUnstartedBuild(bundled, null, problem);
      return null;
    }
    if (!bundled) {
      logger.warn(`[Versions] there is no ${BUNDLED_VERSION_NAME} row to build the pinned stack commit ${pin} into`);
      return null;
    }
    if (deploysBuildOf(bundled, pin)) {
      logger.info(`[Versions] the bundled version deploys from build ${bundled.buildId} of the pinned commit ${pin}`);
      return null;
    }
    logger.info(`[Versions] building the pinned stack commit ${pin} for the bundled version`);
    try {
      return await this.update(bundled.id);
    } catch (err) {
      const hint = err instanceof StackBuildBusyError ? ' Update the bundled version when it is done.' : '';
      const reason = `The pinned stack commit ${pin} was not built: ${getErrorMessage(err)}${hint}`;
      logger.warn(`[Versions] ${reason}`);
      await this.recordUnstartedBuild(bundled, pin, reason);
      return null;
    }
  }

  /**
   * Why a boot did not build the pin, written into the row it could not build.
   *
   * The deploy that started this manager watches that row and tells this
   * boot's answer from an earlier one's by the row having moved, so a boot
   * that starts nothing has to move it or the deploy waits out its whole
   * bound for a build that was never going to run. The row is moved onto the
   * pin for the same reason, and a version that still has a build keeps
   * deploying from it.
   */
  private async recordUnstartedBuild(
    bundled: StackVersionRecord,
    gitRef: string | null,
    reason: string,
  ): Promise<void> {
    if (bundled.buildId === null) await this.versions.markFailed(bundled.id, reason, gitRef);
    else await this.versions.markUpdateFailed(bundled.id, reason, gitRef);
    this.publishChanged();
  }

  /** The commit this manager pins, or a refusal saying there is none to rebuild from. */
  private pinnedStackCommit(): string {
    const pin = readBundledPin(this.bundledRoot);
    if (!pin) {
      throw new BundledVersionError(
        'This manager pins no stack commit, so there is nothing to rebuild the bundled version from. Deploy the manager, or add another version to follow a branch.',
      );
    }
    return pin;
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

  /**
   * Approval names the immutable build the page showed. A legacy row keeps
   * commit-bound approval until publication gives it a build identity.
   * A click from a page rendered before an Update or a refresh
   * is refused rather than applied to whatever arrived since.
   */
  async setTested(
    id: number,
    tested: boolean,
    forCommit: string | null = null,
    forBuild: string | null = null,
  ): Promise<StackVersion> {
    const version = await this.require(id);
    if (tested) {
      if (version.status !== 'ready') {
        throw new InvalidStackVersionError(
          `${version.name} is ${version.status}. Only a version that finished building can be marked as tested.`,
        );
      }
      if (version.commitSha === null) {
        throw new InvalidStackVersionError(
          `${version.name} is at a commit this host cannot tell, so there is no build to mark as tested.`,
        );
      }
      const identityMatches = version.layout === 'builds'
        ? version.buildId !== null && version.buildId === forBuild
        : version.buildId === null && forBuild === null;
      if (forCommit !== version.commitSha || !identityMatches) {
        throw new StackVersionChangedError(version.name, version.commitSha, version.status, version.buildId);
      }
    }

    const updated = await this.versions.setTested(id, tested, forCommit, forBuild);
    if (!updated) {
      const current = await this.versions.findById(id);
      if (!current) throw new StackVersionNotFoundError(id);
      throw new StackVersionChangedError(current.name, current.commitSha, current.status, current.buildId);
    }

    this.publishChanged();
    const deployments = await this.versions.deploymentNames(id);
    return toApiVersion(updated, deployments.length);
  }

  // ---------------------------------------------------------- the settings

  /** The host-owned files of one version, against the samples its build ships. */
  async settingsOf(id: number): Promise<StackSettings> {
    const version = await this.require(id);
    return readHostConfigSettings(version.name, this.settingsSourcesOf(version));
  }

  /** Commits an edit of those files as one revision, and answers the new generation. */
  async saveSettings(id: number, save: StackSettingsSave): Promise<StackSettingsSaved> {
    const version = await this.require(id);
    const sources = readySettingsSources(version.name, this.settingsSourcesOf(version));
    const generation = await saveHostConfigSettings(version.name, sources.configRoot, save);
    logger.info(
      `[Versions] ${version.name} settings saved as revision ${generation}: ${describeSettingsSave(save)}`,
    );
    return { generation };
  }

  /**
   * The current build again, with the settings as they stand now.
   *
   * A saved setting reaches a deployment only through a build that captured
   * it, and fetching and building the stack again for one changed line takes
   * minutes. So this publishes another build of the same commit instead: the
   * current build's tree, its settings files replaced by the committed
   * revision. It holds the build mutex for its whole run, because it publishes
   * a build like any other.
   */
  async applySettings(id: number): Promise<StackSettingsApplied> {
    this.reserveBuild(`version ${id}`);
    try {
      const version = await this.require(id);
      this.buildingName = version.name;
      const applied = await this.publishSettingsBuild(version);
      this.publishChanged();
      return applied;
    } finally {
      this.buildingName = null;
    }
  }

  private async publishSettingsBuild(version: StackVersionRecord): Promise<StackSettingsApplied> {
    const { configRoot, buildRoot: from } = readySettingsSources(
      version.name,
      this.settingsSourcesOf(version),
    );
    const current = readBuildManifest(from);
    if (current.problem !== null) {
      throw new StackSettingsNotReadyError(
        version.name,
        `Build ${version.buildId} cannot be read, so there is nothing to make another one from. ${current.problem}`,
      );
    }

    const capture = await captureHostConfig(configRoot, { sampleEnvKeys: await sampledEnvKeys(from) });
    if (capture.problem !== null) throw new Error(capture.problem);
    const inputs = capture.captured;

    const attempt = randomBytes(6).toString('hex');
    const staging = stagingDirFor(this.versionsRoot, version.name, attempt);
    await mkdir(buildsRootFor(this.versionsRoot, version.name), { recursive: true });
    const buildId = await this.freeBuildId(version.name, current.manifest.commit);
    const built = buildDirFor(this.versionsRoot, version.name, buildId);
    let sharing: BuildTreeSharing = 'linked';
    try {
      const cloned = await cloneBuildTree(
        from,
        staging,
        new Set([...inputs.files.keys(), BUILD_MANIFEST_FILE, BUILD_COMPLETE_MARKER]),
      );
      sharing = cloned.sharing;
      if (cloned.passedBy.length > 0) {
        logger.warn(
          `[Versions] ${version.name}: passed by ${cloned.passedBy.join(', ')} in ${from}, which is neither a file, a directory nor a link`,
        );
      }
      await this.writeSettingsInto(staging, inputs.files);
      await writeFile(
        join(staging, BUILD_MANIFEST_FILE),
        `${JSON.stringify(
          {
            ...current.manifest,
            buildId,
            builtAt: new Date().toISOString(),
            inputGeneration: inputs.generation,
            inputHashes: inputs.hashes,
            treeSharing: cloned.sharing,
          } satisfies BuildManifest,
          null,
          2,
        )}\n`,
      );
      await writeFile(join(staging, BUILD_COMPLETE_MARKER), '');
      await rename(staging, built);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    await this.versions.publish(version.id, {
      buildId,
      commitSha: current.manifest.commit,
      contract: readStackContract(built),
      rootPath: configRoot,
    });
    logger.info(
      `[Versions] ${version.name} deploys from build ${buildId}, made from ${version.buildId} with settings revision ${inputs.generation}, tree ${sharing}`,
    );
    await this.pruneBuilds(version.id);
    return { buildId };
  }

  /** The revision's own bytes, never a link, owner only whatever the build it was made from had. */
  private async writeSettingsInto(
    staging: string,
    files: ReadonlyMap<string, Buffer>,
  ): Promise<void> {
    for (const [relative, bytes] of files) {
      const target = join(staging, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: SETTINGS_FILE_MODE });
    }
  }

  private settingsSourcesOf(version: StackVersionRecord): HostConfigSettingsSources {
    return {
      configRoot: version.rootPath ?? configRootFor(this.versionsRoot, version.name),
      buildRoot: settingsTreeOf(version),
      buildId: version.buildId,
      requiredSecrets: version.contract?.requiredSecrets ?? [],
    };
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

    // The bundled row carries no root until its first build publishes one, and
    // the outcome anchors it there so it deploys from its builds from then on.
    const configRoot = version.rootPath ?? configRootFor(this.versionsRoot, version.name);
    if (version.name === BUNDLED_VERSION_NAME) await this.adoptLegacyHostConfig(configRoot);
    await this.seedHostConfig(configRoot, staging);
    await this.completeHostConfig(configRoot, staging);
    const capture = await captureHostConfig(configRoot, {
      sampleEnvKeys: await sampledEnvKeys(staging),
    });
    if (capture.problem !== null) throw new Error(capture.problem);
    const inputs = capture.captured;

    const buildsRoot = buildsRootFor(this.versionsRoot, version.name);
    await mkdir(buildsRoot, { recursive: true });
    const existing = await this.completeBuildOf(version.name, commit, inputs.generation);
    if (existing) {
      return { buildId: existing.buildId, commitSha: commit, contract, rootPath: configRoot, reused: true };
    }

    await this.writeSettingsInto(staging, inputs.files);
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
    return { buildId, commitSha: commit, contract, rootPath: configRoot, reused: false };
  }

  /**
   * The settings of the tree the manager used to ship, taken over the first
   * time the bundled version is built here. Only the bundled version has a
   * legacy tree, and only a config root with no settings of its own takes it.
   */
  private async adoptLegacyHostConfig(configRoot: string): Promise<void> {
    const { carried, skipped } = await carryOverLegacyHostConfig(configRoot, this.bundledRoot);
    if (carried.length > 0) {
      logger.info(`[Versions] took ${carried.join(', ')} over from ${this.bundledRoot} into ${configRoot}, which had none`);
    }
    if (skipped.length > 0) {
      logger.warn(`[Versions] passed by ${skipped.join(', ')} in ${this.bundledRoot}, where the set wants a regular file or a plain directory. Nothing a link points at becomes a setting of this host.`);
    }
  }

  /** The keys this version declares and the host's own files do not have yet. */
  private async completeHostConfig(configRoot: string, staging: string): Promise<void> {
    for (const [file, keys] of Object.entries(await completeHostConfigFromSamples(configRoot, staging))) {
      logger.info(`[Versions] added ${keys.join(', ')} to ${file} in ${configRoot} from this version's sample`);
    }
  }

  /**
   * The host-owned inputs a version starts with: the samples the build ships,
   * committed as generation one when the version has none of its own yet, so
   * an added version deploys with the stack's defaults the way it always did.
   * A root that has the files but no manifest is adopted as it stands.
   *
   * Every engine the version ships a sample for gets its env here, so the
   * engine half of a version's settings exists to be shown and edited. The
   * stack's own `ensure_engine_env` copies the same sample when the file is
   * missing, so seeding it changes nothing a deploy reads.
   */
  private async seedHostConfig(configRoot: string, staging: string): Promise<void> {
    await mkdir(configRoot, { recursive: true });
    // Which files the root already has is read under the acquisition of the
    // lock that writes, so a file an operator created while the build ran is
    // theirs rather than a sample written over it.
    await withHostConfigLock(configRoot, async (commit) => {
      const seeds: Record<string, Buffer> = {};
      for (const { sample, live } of [...samplePairsIn(staging), DEPLOY_CONFIG_SEED]) {
        if (!existsSync(join(configRoot, live)) && existsSync(join(staging, sample))) {
          seeds[live] = await readFile(join(staging, sample));
        }
      }
      if (Object.keys(seeds).length > 0) {
        await commit(seeds);
        logger.info(`[Versions] seeded ${Object.keys(seeds).join(', ')} in ${configRoot} from the build's samples`);
        return;
      }
      const adopted = await adoptHostConfig(configRoot, commit);
      if (adopted) {
        logger.info(`[Versions] adopted the host configuration in ${configRoot} as generation 1`);
      }
    });
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
   * names. Under the version row's lock, so a claim taking its reference
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
    testedInvalidatedAt: version.testedInvalidatedAt?.toISOString() ?? null,
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
