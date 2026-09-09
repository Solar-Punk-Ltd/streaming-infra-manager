import { getErrorMessage } from '@streaming-infra-manager/common';

import { BUNDLED_SEAL, runBundledSeal } from './cli/bundledSeal.js';
import { CLI_PREFIX, processStreams } from './cli/commandStreams.js';
import { Logger } from './domain/Logger.js';

/**
 * The manager's command line.
 *
 *   node dist/cli.js user:add <username>          on the host, in the api container
 *   node dist/cli.js bundled:seal ...             on the machine a deploy runs from
 *   node dist/cli.js manager:upgrade ...          on the host, from a freshly built image
 *
 * Only `bundled:seal` runs without a database, so it is the only command
 * loaded up front. The other two are loaded when they are asked for, which is
 * what keeps a laptop with no DATABASE_URL from being refused before it has
 * even sealed anything.
 */

const USER_ADD = 'user:add';
const MANAGER_UPGRADE = 'manager:upgrade';

const USAGE = [
  'Usage:',
  '  node dist/cli.js <command> [options]',
  '',
  'Commands:',
  `  ${USER_ADD}         add a user, which is how the first one on a host is made`,
  `  ${BUNDLED_SEAL}     seal the checked out streaming stack into one package`,
  `  ${MANAGER_UPGRADE}  publish a sealed package and bring the project back up`,
  '',
  'Each command refuses with its own usage when its options are wrong.',
].join('\n');

async function main(): Promise<void> {
  // Standard output carries the one line a caller parses, so everything logged goes beside it.
  Logger.getInstance().writeEverythingToStandardError();
  const [command, ...rest] = process.argv.slice(2);

  if (command === BUNDLED_SEAL) return runBundledSeal(rest, processStreams);
  if (command === USER_ADD) return (await import('./cli/userAdd.js')).runUserAdd(rest);
  if (command === MANAGER_UPGRADE) {
    return (await import('./cli/managerUpgrade.js')).runManagerUpgradeCommand(rest, processStreams);
  }

  throw new Error(command ? `unknown command: ${command}\n\n${USAGE}` : USAGE);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    processStreams.err(`${CLI_PREFIX} ${getErrorMessage(err)}`);
    process.exit(1);
  });
