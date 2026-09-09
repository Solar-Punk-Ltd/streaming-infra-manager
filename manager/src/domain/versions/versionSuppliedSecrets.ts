import type { EngineName } from '@streaming-infra-manager/common';

import { parseBaseEnv, parseEngineEnv } from '../../utils/envUtils.js';

/**
 * The keys a version's own settings already answer, so a deployment on it
 * needs nothing generated for them.
 *
 * The settings page shows every generated key and says the manager fills it
 * per deployment unless a value is set here, and this is the half of that
 * sentence the deploy keeps. The value reaches the containers by omission: the
 * deployment's env file is a copy of the version's own base env, and the
 * engine env is read beside it, so a key the manager does not write is a key
 * whose file line stands. That is how `SRT_PASSPHRASE` and `STREAM_KEY` have
 * always worked when a deployment set neither.
 *
 * Both files are read, because the stack splits its secrets between them:
 * `API_AUTH_TOKEN` is the base env's and `SRS_WEBHOOK_TOKEN` the engine's.
 */
export function versionSuppliedSecrets(
  root: string,
  engine: EngineName,
  keys: readonly string[],
): Set<string> {
  const base = parseBaseEnv(root);
  const engineEnv = parseEngineEnv(root, engine);
  const set = (key: string): boolean =>
    (base[key] ?? '').trim() !== '' || (engineEnv[key] ?? '').trim() !== '';
  return new Set(keys.filter(set));
}
