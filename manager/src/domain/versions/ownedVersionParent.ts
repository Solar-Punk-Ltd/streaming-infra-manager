import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const INVALID_PARENT = 'Version parent is not an owned physical directory. Ancestor symbolic links are not allowed.';

function physicalAnchor(path: string): string {
  if (process.platform !== 'darwin') return path;
  for (const alias of ['/tmp', '/var']) {
    if (path !== alias && !path.startsWith(`${alias}/`)) continue;
    const info = lstatSync(alias);
    if (!info.isSymbolicLink()) return path;
    const expected = `/private${alias}`;
    if (resolve(dirname(alias), readlinkSync(alias)) !== expected || realpathSync(alias) !== expected) throw new Error(INVALID_PARENT);
    return expected + path.slice(alias.length);
  }
  return path;
}

/** Only verified macOS system aliases are normalized. First-use reads may validate the nearest existing parent. */
export function assertOwnedVersionParent(root: string, allowMissing = false): boolean {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error(INVALID_PARENT);
  let candidate = root;
  while (true) {
    const expected = physicalAnchor(candidate);
    try {
      const info = lstatSync(expected);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(candidate) !== expected) throw new Error(INVALID_PARENT);
      return candidate === root;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === dirname(candidate)) throw error;
      candidate = dirname(candidate);
    }
  }
}
