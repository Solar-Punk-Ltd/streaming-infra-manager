import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hostConfigFilesOf, withHostConfigLock } from './hostConfigCapture.js';

/**
 * The bundled version's settings, from the tree the manager used to ship them
 * in.
 *
 * On a host deployed before the stack was built here, the bundled stack's base
 * env, deploy config and engine envs live in the legacy tree at
 * `BUNDLED_STACK_ROOT`, and nothing has ever copied them into the versions
 * root. The first build on the host takes them as its config root's first
 * revision, which is what keeps a running deployment's stamp, stream key and
 * passphrase after the manager stops shipping that tree.
 *
 * Read only, once. The legacy tree is what the engines of existing deployments
 * still mount, so nothing is written back into it, and a config root that
 * already holds settings is left alone. Whether it holds any is asked under
 * the edit lock, so a root an operator filled while this waited stays theirs.
 */
export async function carryOverLegacyHostConfig(
  configRoot: string,
  legacyRoot: string,
): Promise<string[]> {
  await mkdir(configRoot, { recursive: true });
  return withHostConfigLock(configRoot, async (commit) => {
    if (hostConfigFilesOf(configRoot).length > 0) return [];
    const carried = hostConfigFilesOf(legacyRoot);
    if (carried.length === 0) return [];

    const files: Record<string, Buffer> = {};
    for (const relative of carried) files[relative] = await readFile(join(legacyRoot, relative));
    await commit(files);
    return carried;
  });
}
