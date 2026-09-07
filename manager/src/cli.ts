import {
  getErrorMessage,
  usernameProblem,
} from '@streaming-infra-manager/common';

import { AuthService } from './domain/auth/AuthService.js';
import { OpenStreams } from './domain/auth/OpenStreams.js';
import { PostgresCredentialRepository } from './domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from './domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from './domain/auth/PostgresUserRepository.js';
import { Database } from './domain/Database.js';
import { Logger } from './domain/Logger.js';
import { config } from './utils/config.js';
import { promptSecret, readSecretFromStdin } from './utils/secretInput.js';

/**
 * The manager's command line, for the one thing that cannot be done through
 * the API: creating a user when none exists yet.
 *
 *   docker compose exec -it api node dist/cli.js user:add <username>
 *   op read "op://<vault>/<item>/password" | \
 *     docker compose exec -T api node dist/cli.js user:add <username> --password-stdin
 *
 * Only the hash reaches Postgres. There is deliberately no way to pass the
 * password as an argument or an environment variable.
 */

const USER_ADD = 'user:add';
const PASSWORD_STDIN_FLAG = '--password-stdin';
const ADMIN_FLAG = '--admin';

const USAGE = [
  'Usage:',
  `  node dist/cli.js ${USER_ADD} <username> [${PASSWORD_STDIN_FLAG}] [${ADMIN_FLAG}]`,
  '',
  'Prompts for the password twice, with nothing echoed. Needs a terminal,',
  `so run it with "docker compose exec -it". With ${PASSWORD_STDIN_FLAG} the`,
  'password is read from a pipe instead, for feeding it from a vault.',
  `${ADMIN_FLAG} lets the new user add and remove users. The first user`,
  'ever added can do that whether or not the flag is given.',
].join('\n');

const logger = Logger.getInstance();

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const password = await readSecretFromStdin();
    if (password === '') throw new Error('no password arrived on stdin');
    return password;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `stdin is not a terminal, so the password cannot be typed. Run this with "docker compose exec -it", or pipe the password in with ${PASSWORD_STDIN_FLAG}.`,
    );
  }

  const password = await promptSecret('Password: ');
  const again = await promptSecret('Password again: ');
  if (password !== again) throw new Error('the two passwords do not match');
  return password;
}

async function addUser(
  username: string,
  fromStdin: boolean,
  admin: boolean,
): Promise<void> {
  // Checked before the prompt, so a bad name is not found out after the
  // password has been typed twice.
  const badName = usernameProblem(username);
  if (badName) throw new Error(`"${username}": ${badName}`);

  const password = await readPassword(fromStdin);
  const database = new Database(config.databaseUrl);

  try {
    // Idempotent, and it means the first user can be created on a host where
    // the API has not started yet.
    await database.migrate();
    const authService = new AuthService(
      new PostgresUserRepository(database.pool),
      new PostgresSessionRepository(database.pool),
      new PostgresCredentialRepository(database.pool),
      new OpenStreams(),
    );
    const created = await authService.addUser(username, password, { admin });
    logger.info(
      `[cli] created user ${username}${created.isAdmin ? ' (can manage users)' : ''}`,
    );
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command !== USER_ADD) {
    throw new Error(
      command ? `unknown command: ${command}\n\n${USAGE}` : USAGE,
    );
  }

  const flags = rest.filter((argument) => argument.startsWith('-'));
  const unknownFlag = flags.find(
    (flag) => flag !== PASSWORD_STDIN_FLAG && flag !== ADMIN_FLAG,
  );
  if (unknownFlag) throw new Error(`unknown option: ${unknownFlag}\n\n${USAGE}`);

  const [username, ...extra] = rest.filter(
    (argument) => !argument.startsWith('-'),
  );
  if (!username || extra.length > 0) {
    throw new Error(`${USER_ADD} takes exactly one username\n\n${USAGE}`);
  }

  await addUser(
    username,
    flags.includes(PASSWORD_STDIN_FLAG),
    flags.includes(ADMIN_FLAG),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error(`[cli] ${getErrorMessage(err)}`);
    process.exit(1);
  });
