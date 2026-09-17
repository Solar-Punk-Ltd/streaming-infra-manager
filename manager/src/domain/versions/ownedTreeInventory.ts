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
export interface OwnedTreeInventory {
  rootMode: number;
  entries: OwnedTreeEntry[];
  stamps: Record<string, string>;
  durableStamps: Record<string, string>;
}
/** What an inventory kept beyond the walk that took it keeps: the shape to reproduce, and the stamps to prove it by. */
export type RecordedOwnedTree = Pick<OwnedTreeInventory, 'rootMode' | 'entries' | 'durableStamps'>;
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
/**
 * The fields of a stamp that still hold after the tree has been linked from,
 * with the file's identity first so `inodeOfStamp` can read it as a prefix.
 *
 * The status-change time is left out on purpose, and so is the link count that
 * moves with it. Making a hard link to a file moves both without touching one
 * of its bytes, and preparing an execution copy links every regular file of
 * the build, so a record taken when the build was published would stop
 * matching the moment the first deploy ran. What that leaves undetected is a
 * writer who changes a file and then puts its size, mode and modification time
 * back, which is somebody with write access to the versions root, who can
 * replace the whole build instead.
 */
const durableStamp = (info: BigIntStats): string => [info.dev, info.ino, info.mode, info.size, info.mtimeNs].join(':');
/** The device and inode a durable stamp opens with. Two paths whose stamps share it are one file, so they hold the same bytes. */
export const inodeOfStamp = (durable: string): string => durable.split(':', 2).join(':');
export const byPath = (left: { path: string }, right: { path: string }): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** The caller owns this tree exclusively and has stopped its builder before inventory starts. */
export async function inventoryOwnedTree(root: string, excludedRootFile?: string): Promise<OwnedTreeInventory> {
  await assertOwnedTreeLinks(root);
  const entries: OwnedTreeEntry[] = [];
  const stamps: Record<string, string> = {};
  const durableStamps: Record<string, string> = {};
  const rootInfo = await lstat(root, { bigint: true });
  async function walk(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    const directoryInfo = await lstat(join(root, directory), { bigint: true });
    stamps[directory] = stamp(directoryInfo);
    durableStamps[directory] = durableStamp(directoryInfo);
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
      durableStamps[path] = durableStamp(info);
    }
    if (stamp(directoryInfo) !== stamp(await lstat(join(root, directory), { bigint: true }))) throw new Error('Package directory changed during inventory.');
  }
  await walk('');
  return { rootMode: Number(rootInfo.mode & 0o7777n), entries: entries.sort(byPath), stamps, durableStamps };
}

async function stampWalk(root: string, of: (info: BigIntStats) => string, excludedRootFile?: string): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    stamps[directory] = of(await lstat(join(root, directory), { bigint: true }));
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      assertRelativeTreePath(path);
      if (path === excludedRootFile) continue;
      const info = await lstat(join(root, path), { bigint: true });
      stamps[path] = of(info);
      if (info.isDirectory()) await walk(path);
    }
  }
  await walk('');
  return stamps;
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
export const stampOwnedTree = (root: string, excludedRootFile?: string): Promise<OwnedTreeInventory['stamps']> =>
  stampWalk(root, stamp, excludedRootFile);

/** The same walk against a record that outlives the links made from the tree, so without the status-change time. */
export const durableStampOwnedTree = (root: string, excludedRootFile?: string): Promise<OwnedTreeInventory['durableStamps']> =>
  stampWalk(root, durableStamp, excludedRootFile);
