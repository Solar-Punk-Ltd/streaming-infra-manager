import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { assertOwnedDirectory, assertRelativeTreePath } from './ownedTreePaths.js';

export function isHostInputPath(path: string): boolean {
  try { assertRelativeTreePath(path); } catch { return false; }
  return path === '.env' || path === 'deploy/config.json' || /^engines\/[^/]+\/\.env$/.test(path);
}

async function present(root: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Host input is not a regular file or is a symbolic link.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function directoryPresent(root: string, path: string): Promise<boolean> {
  try { await assertOwnedDirectory(root, path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ownedHostInputPaths(root: string): Promise<string[]> {
  await assertOwnedDirectory(root);
  const paths: string[] = [];
  if (await present(root, '.env')) paths.push('.env');
  if (await directoryPresent(root, 'deploy') && await present(root, 'deploy/config.json')) paths.push('deploy/config.json');
  if (await directoryPresent(root, 'engines')) {
    for (const engine of (await readdir(join(root, 'engines'))).sort()) {
      const path = `engines/${engine}`;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error('Host input directory is a symbolic link.');
      if (info.isDirectory() && await present(root, `${path}/.env`)) paths.push(`${path}/.env`);
    }
  }
  return paths;
}
