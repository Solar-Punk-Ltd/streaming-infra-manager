import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { captureManagerUpgradeRequest, runManagerUpgrade, type BundledBuildOutcome, type ManagerUpgradeOperations } from '../domain/versions/ManagerUpgrade.js';
import { retainedUpgradePhase, UPGRADE_ALREADY_OWNED } from '../domain/versions/managerUpgradeGuard.js';
import { managerUpgradeGuardRootFor } from '../domain/versions/stackPaths.js';
import { config } from '../utils/config.js';
import { BUNDLED_STACK_ROOT } from '../utils/envUtils.js';
import { MANAGER_POSTGRES_VOLUME } from '../domain/versions/managerProject.js';
import { apiHealthUrlFor, ComposeUpgradeOperations, type ComposeUpgradeSettings } from './ComposeUpgradeOperations.js';
import { CLI_PREFIX, type CommandStreams } from './commandStreams.js';
import { execFileCommandRunner } from './commandRunner.js';
import { parseFlags, withUsage } from './flags.js';
import { PostgresManagerUpgradeDatabase } from './managerUpgradeDatabase.js';

export const MANAGER_UPGRADE = 'manager:upgrade';

const MANAGER_COMMIT = '--manager-commit';
const MANAGER_DIGEST = '--manager-digest';
const IMAGE_ID = '--image-id';
const PROJECT = '--project';
const COMPOSE_FILE = '--compose-file';
const MUTABLE_ROOT = '--mutable-root';
const PUBLIC_EDGE = '--public-edge';
const FIRST_USE = '--first-use';
const BUNDLED_TIMEOUT = '--bundled-timeout';

/** A wait a person would set: never nothing, never longer than a day. */
const MIN_BUNDLED_TIMEOUT_SECONDS = 1;
const MAX_BUNDLED_TIMEOUT_SECONDS = 86_400;

function bundledTimeoutMs(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_BUNDLED_TIMEOUT_SECONDS || seconds > MAX_BUNDLED_TIMEOUT_SECONDS) {
    throw new Error(`${BUNDLED_TIMEOUT} must be a whole number of seconds between ${MIN_BUNDLED_TIMEOUT_SECONDS} and ${MAX_BUNDLED_TIMEOUT_SECONDS}.`);
  }
  return seconds * 1000;
}

/** What a bundled build that did not finish tells the deployer, or null when it did. */
function bundledFailure(bundled: BundledBuildOutcome): string | null {
  if (bundled.state === 'ready' || bundled.state === 'unpinned') return null;
  const what = bundled.state === 'timed-out' ? 'did not finish in time' : 'failed';
  const reason = bundled.problem ? ` ${bundled.problem}` : '';
  return `The manager is up, but the bundled stack build of ${bundled.commit} ${what}.${reason} Retry it from the Versions page.`;
}

const RETAINED_GUARD_ADVICE = 'A person checks the host before removing that directory.';

/** Every path this command takes is one the host reads, so each is absolute and written out in full. */
function assertPlainPath(flag: string, value: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${flag} must be an absolute path written out in full, with no "." or ".." step in it.`);
  }
}

function assertComposeFileInside(composeFile: string, mutableRoot: string): void {
  assertPlainPath(MUTABLE_ROOT, mutableRoot);
  assertPlainPath(COMPOSE_FILE, composeFile);
  const step = relative(mutableRoot, composeFile);
  if (!step || step === '..' || step.startsWith(`..${sep}`) || isAbsolute(step)) {
    throw new Error(`${COMPOSE_FILE} must name a file inside the tree given by ${MUTABLE_ROOT}.`);
  }
}

export const MANAGER_UPGRADE_USAGE = [
  'Usage:',
  `  node dist/cli.js ${MANAGER_UPGRADE} ${MANAGER_COMMIT} <sha> ${MANAGER_DIGEST} <sha256>`,
  `      ${IMAGE_ID} sha256:<sha256> ${PROJECT} <compose project>`,
  `      ${COMPOSE_FILE} <path> ${MUTABLE_ROOT} <path> ${BUNDLED_TIMEOUT} <seconds>`,
  `      [${PUBLIC_EDGE}] [${FIRST_USE}]`,
  '',
  'Brings the project back up on the image the deploy has just built, holding',
  'one directory under the stack versions root for the whole run so a second',
  'upgrade cannot start beside it. The identity flags describe exactly what is',
  'being installed, and any of them being wrong is a refusal before anything on',
  'the host is touched.',
  '',
  `${BUNDLED_TIMEOUT} is how long to wait, once the api answers, for its own boot`,
  'to fetch and build the stack commit this manager pins. A build that fails or',
  'never finishes is reported and this command exits non zero, after it has let',
  'go of the host, because the manager is up and the Versions page can retry it.',
  '',
  `${PUBLIC_EDGE} starts the TLS edge with the project. Without it the edge is`,
  'removed by name and the removal is checked.',
  '',
  `${FIRST_USE} says the deploy found a host that has never run the manager, so`,
  'the database this upgrade reads has to be empty. The deploy decides that',
  'before this container exists, because starting it can create the project',
  'volumes and a probe from in here would see one nothing has written to.',
  '',
  'Prints one line of JSON on standard output with the state of the upgrade and',
  'the bundled build it waited for.',
].join('\n');

/** How the upgrade reaches the host, which a test replaces. */
export type UpgradeOperationsFactory = (settings: ComposeUpgradeSettings) => {
  operations: ManagerUpgradeOperations;
  close(): Promise<void>;
};

export interface ManagerUpgradeDependencies {
  versionsRoot?: string;
  operations?: UpgradeOperationsFactory;
}

const composeOperations: UpgradeOperationsFactory = (settings) => {
  const database = new PostgresManagerUpgradeDatabase(config.databaseUrl);
  return {
    operations: new ComposeUpgradeOperations(settings, database, execFileCommandRunner),
    close: () => database.close(),
  };
};

/** Everything a retained guard can tell a person, without removing anything. */
function reportRetainedGuard(guardRoot: string, streams: CommandStreams, heldByAnEarlierRun: boolean): void {
  const holder = heldByAnEarlierRun ? 'an earlier manager upgrade still holds' : 'this manager upgrade stopped and still holds';
  streams.err(`${CLI_PREFIX} ${holder} ${guardRoot}`);
  let phase: string | null = null;
  try {
    phase = retainedUpgradePhase(guardRoot);
  } catch (error) {
    streams.err(`${CLI_PREFIX} its record could not be read: ${getErrorMessage(error)}`);
  }
  if (phase) streams.err(`${CLI_PREFIX} it stopped in the ${phase} phase`);
  streams.err(`${CLI_PREFIX} ${RETAINED_GUARD_ADVICE}`);
}

/**
 * Runs one manager upgrade on the host, from the image the deploy has just
 * built. The database is opened only here, because this command needs one.
 */
export async function runManagerUpgradeCommand(
  argv: readonly string[],
  streams: CommandStreams,
  dependencies: ManagerUpgradeDependencies = {},
): Promise<void> {
  const versionsRoot = dependencies.versionsRoot ?? config.stackVersionsRoot;
  const { request, settings, environment } = withUsage(MANAGER_UPGRADE_USAGE, () => {
    const flags = parseFlags(argv, {
      valued: [MANAGER_COMMIT, MANAGER_DIGEST, IMAGE_ID, PROJECT, COMPOSE_FILE, MUTABLE_ROOT, BUNDLED_TIMEOUT],
      switches: [PUBLIC_EDGE, FIRST_USE],
    });
    assertComposeFileInside(flags.required(COMPOSE_FILE), flags.required(MUTABLE_ROOT));
    return {
      // Checked before anything is opened, so a mistyped identity costs no connection and no ownership.
      request: captureManagerUpgradeRequest({
        manager: { sourceCommit: flags.required(MANAGER_COMMIT), sourceDigest: flags.required(MANAGER_DIGEST), imageId: flags.required(IMAGE_ID) },
        project: flags.required(PROJECT),
      }),
      settings: {
        versionsRoot,
        composeFile: flags.required(COMPOSE_FILE),
        bundledStackRoot: BUNDLED_STACK_ROOT,
        publicEdge: flags.has(PUBLIC_EDGE),
        firstUse: flags.has(FIRST_USE),
        postgresVolume: MANAGER_POSTGRES_VOLUME,
        apiHealthUrl: apiHealthUrlFor(config.port),
        timeouts: { bundledBuild: bundledTimeoutMs(flags.required(BUNDLED_TIMEOUT)) },
      } satisfies ComposeUpgradeSettings,
      environment: { guardRoot: managerUpgradeGuardRootFor(versionsRoot), mutableRoot: flags.required(MUTABLE_ROOT) },
    };
  });
  let host: ReturnType<UpgradeOperationsFactory> | null = null;

  try {
    host = (dependencies.operations ?? composeOperations)(settings);
    const result = await runManagerUpgrade(environment, request, host.operations);
    // Printed before the refusal below, because the deploy reads this line
    // either way and the bundled build is what it says most about.
    streams.out(JSON.stringify({ state: result.state, bundled: result.bundled }));
    const failure = bundledFailure(result.bundled);
    if (failure) throw new Error(failure);
  } catch (error) {
    // A directory still there after a failure is the first thing a person has to look at,
    // whether this run left it or found it.
    const heldByAnEarlierRun = getErrorMessage(error) === UPGRADE_ALREADY_OWNED;
    if (heldByAnEarlierRun || existsSync(environment.guardRoot)) {
      reportRetainedGuard(environment.guardRoot, streams, heldByAnEarlierRun);
    }
    throw error;
  } finally {
    await host?.close();
  }
}
