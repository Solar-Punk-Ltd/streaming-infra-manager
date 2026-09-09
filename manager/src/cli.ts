import { getErrorMessage } from '@streaming-infra-manager/common';

import { CLI_PREFIX, processStreams } from './cli/commandStreams.js';
import { Logger } from './domain/Logger.js';

/**
 * The manager's command line, both of whose commands run on the host, in the
 * api container.
 *
 *   node dist/cli.js user:add <username>
 *   node dist/cli.js manager:upgrade ...
 *
 * Each is loaded when it is asked for, because each opens a database and a
 * caller asking for the usage of one should not be refused for the other.
 */

const USER_ADD = 'user:add';
const MANAGER_UPGRADE = 'manager:upgrade';

const USAGE = [
  'Usage:',
  '  node dist/cli.js <command> [options]',
  '',
  'Commands:',
  `  ${USER_ADD}         add a user, which is how the first one on a host is made`,
  `  ${MANAGER_UPGRADE}  bring the project back up on a freshly built image`,
  '',
  'Each command refuses with its own usage when its options are wrong.',
].join('\n');

async function main(): Promise<void> {
  // Standard output carries the one line a caller parses, so everything logged goes beside it.
  Logger.getInstance().writeEverythingToStandardError();
  const [command, ...rest] = process.argv.slice(2);

  if (command === USER_ADD) return (await import('./cli/userAdd.js')).runUserAdd(rest);
  if (command === MANAGER_UPGRADE) {
    return (await import('./cli/managerUpgrade.js')).runManagerUpgradeCommand(rest, processStreams);
  }

  throw new Error(command ? `unknown command: ${command}\n\n${USAGE}` : USAGE);
}

main()
  // The exit code is set rather than taken, because ending the process here can
  // drop the line already written to a standard output that is a pipe.
  .then(() => { process.exitCode = 0; })
  .catch((err: unknown) => {
    processStreams.err(`${CLI_PREFIX} ${getErrorMessage(err)}`);
    process.exit(1);
  });
