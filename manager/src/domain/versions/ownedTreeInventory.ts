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
/**
 * The mode every symbolic link is recorded with.
 *
 * Linux gives a symbolic link 0777 and has no call that changes it, while
 * macOS gives 0755 and can. A tree sealed on one and read on the other would
 * otherwise never match, so the mode of a link is not read from the filesystem
 * at all.
 */
const SYMLINK_MODE = 0o777;
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
        entries.push({ ...base, mode: SYMLINK_MODE, type: 'symlink', target: await readlink(join(root, path)) });
      } else throw new Error('Package tree contains an unsupported file type.');
      if (stamp(info) !== stamp(await lstat(join(root, path), { bigint: true }))) throw new Error('Package tree changed during inventory.');
      stamps[path] = stamp(info);
    }
    if (stamp(directoryInfo) !== stamp(await lstat(join(root, directory), { bigint: true }))) throw new Error('Package directory changed during inventory.');
  }
  await walk('');
  return { rootMode: Number(rootInfo.mode & 0o7777n), entries: entries.sort(byPath), stamps };
}

/**
 * The stamps an inventory of this tree would record, and none of its bytes.
 *
 * What a caller does with these is prove that a tree it has already inventoried
 * has not moved since, which is what the inventory keeps its stamps for. A
 * write moves the file's ctime, a chmod moves it, and a path that arrives or
 * leaves changes which keys are here, so a tree that matches stamp for stamp is
 * the tree that was inventoried. Nothing is opened and no link is followed, so
 * a tree that has grown one is refused by the comparison rather than read.
 */
export async function stampOwnedTree(root: string, excludedRootFile?: string): Promise<OwnedTreeInventory['stamps']> {
  const stamps: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    stamps[directory] = stamp(await lstat(join(root, directory), { bigint: true }));
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      assertRelativeTreePath(path);
      if (path === excludedRootFile) continue;
      const info = await lstat(join(root, path), { bigint: true });
      stamps[path] = stamp(info);
      if (info.isDirectory()) await walk(path);
    }
  }
  await walk('');
  return stamps;
}

/**
 * The stamp `stampOwnedTree` would record for one path.
 *
 * For a caller that has moved a few of a tree's stamps itself and needs to say
 * what a later comparison of the whole tree should find where it did.
 */
export const pathStamp = async (path: string): Promise<string> => stamp(await lstat(path, { bigint: true }));
