import { getErrorMessage } from '@streaming-infra-manager/common';

import { captureManagerUpgradeRequest, runManagerUpgrade, type ManagerUpgradeOperations } from '../domain/versions/ManagerUpgrade.js';
import { retainedUpgradePhase, UPGRADE_ALREADY_OWNED } from '../domain/versions/managerUpgradeGuard.js';
import { managerUpgradeGuardRootFor } from '../domain/versions/stackPaths.js';
import { config } from '../utils/config.js';
import { ComposeUpgradeOperations, type ComposeUpgradeSettings } from './ComposeUpgradeOperations.js';
import { CLI_PREFIX, type CommandStreams } from './commandStreams.js';
import { execFileCommandRunner } from './commandRunner.js';
import { parseFlags, withUsage } from './flags.js';
import { PostgresManagerUpgradeDatabase } from './managerUpgradeDatabase.js';

export const MANAGER_UPGRADE = 'manager:upgrade';

const SHIPMENT_ID = '--shipment-id';
const COMMIT = '--commit';
const DIGEST = '--digest';
const MANAGER_COMMIT = '--manager-commit';
const MANAGER_DIGEST = '--manager-digest';
const IMAGE_ID = '--image-id';
const PROJECT = '--project';
const COMPOSE_FILE = '--compose-file';
const MUTABLE_ROOT = '--mutable-root';
const TOOLCHAIN = '--toolchain';
const PUBLIC_EDGE = '--public-edge';
const FIRST_USE = '--first-use';

const RETAINED_GUARD_ADVICE = 'A person checks the host before removing that directory.';

export const MANAGER_UPGRADE_USAGE = [
  'Usage:',
  `  node dist/cli.js ${MANAGER_UPGRADE} ${SHIPMENT_ID} <uuid> ${COMMIT} <sha> ${DIGEST} <sha256>`,
  `      ${MANAGER_COMMIT} <sha> ${MANAGER_DIGEST} <sha256> ${IMAGE_ID} sha256:<sha256>`,
  `      ${PROJECT} <compose project> ${COMPOSE_FILE} <path> ${MUTABLE_ROOT} <path>`,
  `      ${TOOLCHAIN} <text> [${PUBLIC_EDGE}] [${FIRST_USE}]`,
  '',
  'Publishes the package the deploy shipped and brings the project back up,',
  'holding one directory under the stack versions root for the whole run so a',
  'second upgrade cannot start beside it. The identity flags describe exactly',
  'what is being installed, and any of them being wrong is a refusal before',
  'anything on the host is touched.',
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
  'the receipt of the publication.',
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
  const database = new PostgresManagerUpgradeDatabase(config.databaseUrl, settings.versionsRoot);
  return {
    operations: new ComposeUpgradeOperations(settings, database, execFileCommandRunner),
    close: () => database.close(),
  };
};

/** Everything a retained guard can tell a person, without removing anything. */
function reportRetainedGuard(guardRoot: string, streams: CommandStreams): void {
  streams.err(`${CLI_PREFIX} an earlier manager upgrade still holds ${guardRoot}`);
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
      valued: [SHIPMENT_ID, COMMIT, DIGEST, MANAGER_COMMIT, MANAGER_DIGEST, IMAGE_ID, PROJECT, COMPOSE_FILE, MUTABLE_ROOT, TOOLCHAIN],
      switches: [PUBLIC_EDGE, FIRST_USE],
    });
    return {
      // Checked before anything is opened, so a mistyped identity costs no connection and no ownership.
      request: captureManagerUpgradeRequest({
        shipment: { shipmentId: flags.required(SHIPMENT_ID), commit: flags.required(COMMIT), digest: flags.required(DIGEST) },
        manager: { sourceCommit: flags.required(MANAGER_COMMIT), sourceDigest: flags.required(MANAGER_DIGEST), imageId: flags.required(IMAGE_ID) },
        project: flags.required(PROJECT),
      }),
      settings: {
        versionsRoot,
        composeFile: flags.required(COMPOSE_FILE),
        toolchain: flags.required(TOOLCHAIN),
        publicEdge: flags.has(PUBLIC_EDGE),
        firstUse: flags.has(FIRST_USE),
      } satisfies ComposeUpgradeSettings,
      environment: { guardRoot: managerUpgradeGuardRootFor(versionsRoot), mutableRoot: flags.required(MUTABLE_ROOT) },
    };
  });
  const host = (dependencies.operations ?? composeOperations)(settings);

  try {
    const result = await runManagerUpgrade(environment, request, host.operations);
    streams.out(JSON.stringify({ state: result.state, receipt: result.receipt }));
  } catch (error) {
    if (getErrorMessage(error) === UPGRADE_ALREADY_OWNED) reportRetainedGuard(environment.guardRoot, streams);
    throw error;
  } finally {
    await host.close();
  }
}
