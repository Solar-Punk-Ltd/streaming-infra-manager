import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { assertOwnedDirectory, assertOwnedTreeLinks, assertRelativeTreePath, readOwnedFile, readSharedOwnedFile } from './ownedTreePaths.js';

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
  /** Strict for directories and links, durable for regular files that may gain or lose hard links. */
  sharedStamps: Record<string, string>;
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
 * in the order `inodeOfStamp` and `modeOfStamp` read them out of.
 *
 * The status-change time is the one field of the full stamp left out here. It
 * moves when a hard link is made to the file, as the link count does, and
 * preparing an execution copy links every regular file of the build, so a
 * record taken when the build was first copied would stop matching the moment
 * the next deploy ran. Neither the link count nor the owner has ever been in a
 * stamp, so neither is compared. What this leaves undetected is a writer who
 * changes a file and then puts its size, mode and modification time back, which
 * is somebody with write access to the versions root, who can replace the whole
 * build instead.
 */
const durableStamp = (info: BigIntStats): string => [info.dev, info.ino, info.mode, info.size, info.mtimeNs].join(':');
const sharedStamp = (info: BigIntStats): string => info.isFile() ? durableStamp(info) : stamp(info);
/** The device and inode a durable stamp opens with. Two paths whose stamps share it are one file, so they hold the same bytes. */
export const inodeOfStamp = (durable: string): string => durable.split(':', 2).join(':');

/** The `st_mode` a durable stamp carries third, file type bits and all, or null when the stamp holds no mode. */
export function modeOfStamp(durable: string): number | null {
  const [, , mode] = durable.split(':');
  if (mode === undefined || !/^[0-9]+$/.test(mode)) return null;
  const value = Number(mode);
  return Number.isSafeInteger(value) ? value : null;
}

/** The `st_mode` bits that say what a path is, and what each kind of entry claims them to be. */
export const FILE_TYPE_MASK = 0o170000;
export const FILE_TYPE_BITS: Record<OwnedTreeEntry['type'], number> = {
  directory: 0o040000,
  file: 0o100000,
  symlink: 0o120000,
};
export const byPath = (left: { path: string }, right: { path: string }): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * How a walk learns a regular file's sha256, given its path in the tree being
 * walked and the durable stamp just read of it.
 */
export type FileDigestSource = (path: string, durable: string) => Promise<string>;

async function walkOwnedTree(
  root: string,
  digestOf: FileDigestSource,
  excludedRootFile?: string,
  sharedRegularFiles = false,
): Promise<OwnedTreeInventory> {
  await assertOwnedTreeLinks(root);
  const entries: OwnedTreeEntry[] = [];
  const stamps: Record<string, string> = {};
  const durableStamps: Record<string, string> = {};
  const sharedStamps: Record<string, string> = {};
  const rootInfo = await lstat(root, { bigint: true });
  async function walk(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    const directoryInfo = await lstat(join(root, directory), { bigint: true });
    stamps[directory] = stamp(directoryInfo);
    durableStamps[directory] = durableStamp(directoryInfo);
    sharedStamps[directory] = stamp(directoryInfo);
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      assertRelativeTreePath(path);
      if (path === excludedRootFile) continue;
      const info = await lstat(join(root, path), { bigint: true });
      const durable = durableStamp(info);
      const base = { path, mode: Number(info.mode & 0o7777n) };
      if (info.isDirectory()) {
        entries.push({ ...base, type: 'directory' });
        await walk(path);
      } else if (info.isFile()) {
        entries.push({ ...base, type: 'file', sha256: await digestOf(path, durable) });
      } else if (info.isSymbolicLink()) {
        entries.push({ ...base, mode: SYMLINK_MODE, type: 'symlink', target: await readlink(join(root, path)) });
      } else throw new Error('Package tree contains an unsupported file type.');
      const identity = sharedRegularFiles ? sharedStamp : stamp;
      if (identity(info) !== identity(await lstat(join(root, path), { bigint: true }))) throw new Error('Package tree changed during inventory.');
      stamps[path] = stamp(info);
      durableStamps[path] = durable;
      sharedStamps[path] = sharedStamp(info);
    }
    if (stamp(directoryInfo) !== stamp(await lstat(join(root, directory), { bigint: true }))) throw new Error('Package directory changed during inventory.');
  }
  await walk('');
  return { rootMode: Number(rootInfo.mode & 0o7777n), entries: entries.sort(byPath), stamps, durableStamps, sharedStamps };
}

/** The caller owns this tree exclusively and has stopped its builder before inventory starts. */
export const inventoryOwnedTree = (root: string, excludedRootFile?: string): Promise<OwnedTreeInventory> =>
  walkOwnedTree(root, async path => sha256(await readOwnedFile(root, path)), excludedRootFile);

/** Inventory a published tree whose regular files may be hard linked by another deployment while it is read. */
export const inventorySharedOwnedTree = (root: string, excludedRootFile?: string): Promise<OwnedTreeInventory> =>
  walkOwnedTree(root, async path => sha256(await readSharedOwnedFile(root, path)), excludedRootFile, true);

/**
 * The same walk over a tree whose regular files are hard links of a tree that
 * has already been hashed, where the caller answers a file's digest from the
 * inode it shares rather than from its bytes.
 */
export const inventoryLinkedTree = (root: string, digestOf: FileDigestSource): Promise<OwnedTreeInventory> =>
  walkOwnedTree(root, digestOf, undefined, true);

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

/** Strict non-file stamps and durable regular-file stamps for a published hard-linked tree. */
export const sharedStampOwnedTree = (root: string, excludedRootFile?: string): Promise<OwnedTreeInventory['sharedStamps']> =>
  stampWalk(root, sharedStamp, excludedRootFile);

/** The durable stamp of one path, for a caller asking whether a record still describes the thing it names. */
export const durablePathStamp = async (path: string): Promise<string> => durableStamp(await lstat(path, { bigint: true }));
