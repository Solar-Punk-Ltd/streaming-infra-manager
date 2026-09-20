import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { envKeysIn } from './versions/hostConfigCapture.js';

/**
 * The environment a stack script is handed, with the manager's own names taken
 * out of it.
 *
 * The manager runs in a container whose environment names many of the same
 * things a deployment does, and on every one of those names the manager's
 * value is the one that wins. `load_env_file` in the stack's `_lib.sh` reads
 * the deployment's env file as defaults and leaves an already exported
 * variable standing, and docker compose prefers a shell variable over an
 * `--env-file` value. So `LOG_LEVEL=debug`, set for the manager, becomes the
 * stream-uploader's log level too, and `BEE_DATA_ROOT`, which here is where
 * one deployment's own files live, is in the stack the parent of every Bee
 * node's data directory.
 *
 * What is removed is named rather than what is kept, so everything a script
 * legitimately reads from the machine it runs on, PATH, HOME, SSH_AUTH_SOCK,
 * DOCKER_HOST and the rest, still reaches it.
 */

const ROOT_ENV_SAMPLE = '.env.sample';
const ENGINES_DIR = 'engines';

/**
 * Names that never reach a script whatever the samples say. The database pair
 * is the manager's alone and no deploy script asks for it. `BEE_DATA_ROOT` and
 * `LOG_LEVEL` each mean one thing here and another in the stack, and the stack
 * reads them from compose rather than from a sample, so nothing else would
 * catch them. The two admin tokens are process-routed credentials. A consuming
 * job must add one back explicitly rather than inherit it into every script.
 */
const NEVER_INHERITED: readonly string[] = [
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'BEE_DATA_ROOT',
  'LOG_LEVEL',
  'ADMIN_API_TOKEN',
  'RELEASE_GUARD_ADMIN_TOKEN',
];

/**
 * Every key the samples of one stack checkout declare, root and engines alike.
 *
 * The samples are the version's own statement of what it reads, which is why
 * the strip list follows the checkout being deployed rather than a list kept
 * here: a version that starts reading a new key is covered on the deploy that
 * brings it in.
 */
export function stackDeclaredKeys(stackRoot: string): Set<string> {
  const keys = envKeysIn(readIfThere(join(stackRoot, ROOT_ENV_SAMPLE)));
  for (const engine of enginesIn(stackRoot)) {
    const sample = readIfThere(join(stackRoot, ENGINES_DIR, engine, ROOT_ENV_SAMPLE));
    for (const key of envKeysIn(sample)) keys.add(key);
  }
  return keys;
}

/**
 * The inherited environment without the deployment's own names, and with what
 * the manager sets on purpose applied over it.
 *
 * `stackRoot` left out is a script run from no checkout of its own, such as the
 * stack version build, and the fixed list is then the whole of the strip.
 */
export function scriptEnv(
  inherited: NodeJS.ProcessEnv,
  stackRoot: string | undefined,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const strip = new Set(NEVER_INHERITED);
  if (stackRoot !== undefined) {
    for (const key of stackDeclaredKeys(stackRoot)) strip.add(key);
  }

  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!strip.has(key)) kept[key] = value;
  }
  return { ...kept, ...overrides };
}

function readIfThere(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function enginesIn(stackRoot: string): string[] {
  const dir = join(stackRoot, ENGINES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
