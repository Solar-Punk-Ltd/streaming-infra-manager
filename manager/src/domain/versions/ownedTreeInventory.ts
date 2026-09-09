import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { assertOwnedDirectory, assertOwnedTreeLinks, assertRelativeTreePath, readOwnedFile } from './ownedTreePaths.js';

export type OwnedTreeEntry = { path: string; mode: number } & (
  | { type: 'directory' }
  | { type: 'file'; sha256: string }
  | { type: 'symlink'; target: string }
);
export interface OwnedTreeInventory { rootMode: number; entries: OwnedTreeEntry[]; stamps: Record<string, string> }
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
/** Format 1 is shared by final artifacts, execution sources and rollout recovery evidence. */
export const ownedTreeDigest = ({ rootMode, entries }: Pick<OwnedTreeInventory, 'rootMode' | 'entries'>): string =>
  sha256(JSON.stringify({ format: 1, rootMode, entries }));
const stamp = (info: BigIntStats): string => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':');
export const byPath = (left: { path: string }, right: { path: string }): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** The caller owns this tree exclusively and has stopped its builder before inventory starts. */
export async function inventoryOwnedTree(root: string, excludedRootFile?: string): Promise<OwnedTreeInventory> {
  await assertOwnedTreeLinks(root);
  const entries: OwnedTreeEntry[] = [];
  const stamps: Record<string, string> = {};
  const rootInfo = await lstat(root, { bigint: true });
  async function walk(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    const directoryInfo = await lstat(join(root, directory), { bigint: true });
    stamps[directory] = stamp(directoryInfo);
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      assertRelativeTreePath(path);
      if (path === excludedRootFile) continue;
      const info = await lstat(join(root, path), { bigint: true });
      const base = { path, mode: Number(info.mode & 0o7777n) };
      if (info.isDirectory()) {
        entries.push({ ...base, type: 'directory' });
        await walk(path);
      } else if (info.isFile()) {
        entries.push({ ...base, type: 'file', sha256: sha256(await readOwnedFile(root, path)) });
      } else if (info.isSymbolicLink()) {
        entries.push({ ...base, type: 'symlink', target: await readlink(join(root, path)) });
      } else throw new Error('Package tree contains an unsupported file type.');
      if (stamp(info) !== stamp(await lstat(join(root, path), { bigint: true }))) throw new Error('Package tree changed during inventory.');
      stamps[path] = stamp(info);
    }
    if (stamp(directoryInfo) !== stamp(await lstat(join(root, directory), { bigint: true }))) throw new Error('Package directory changed during inventory.');
  }
  await walk('');
  return { rootMode: Number(rootInfo.mode & 0o7777n), entries: entries.sort(byPath), stamps };
}
