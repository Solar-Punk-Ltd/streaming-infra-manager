import type { Dirent } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One build's tree copied into a staging directory, sharing bytes where the
 * filesystem allows it.
 *
 * A published build is never written to again, so two builds of one commit can
 * point at the same inodes and the second one costs nothing but its own
 * settings files. Hard links are the whole point: the tree is a `node_modules`
 * and a set of built bundles, hundreds of megabytes that differ in nothing.
 *
 * Nothing here is followed. A link in the source tree is recreated as a link,
 * so a tree that names bytes outside itself keeps naming them rather than
 * having them copied in.
 */

/** Whether every regular file was shared, or something had to be copied instead. */
export type BuildTreeSharing = 'linked' | 'copied';

export interface ClonedBuildTree {
  sharing: BuildTreeSharing;
  /** Paths that are neither a file, a directory nor a link, so nothing was made of them. */
  passedBy: string[];
}

/** Why a link cannot stand in for a copy, rather than why the copy would fail too. */
const COPY_INSTEAD = new Set(['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Fills `to` from `from`, leaving out the relative paths in `skip`, which the
 * caller writes itself.
 */
export async function cloneBuildTree(
  from: string,
  to: string,
  skip: ReadonlySet<string>,
): Promise<ClonedBuildTree> {
  const cloned: ClonedBuildTree = { sharing: 'linked', passedBy: [] };
  await mkdir(to, { recursive: true });
  await chmod(to, (await lstat(from)).mode & 0o777);
  await cloneInto(from, to, '', skip, cloned);
  return cloned;
}

async function cloneInto(
  from: string,
  to: string,
  prefix: string,
  skip: ReadonlySet<string>,
  cloned: ClonedBuildTree,
): Promise<void> {
  for (const entry of await readdir(join(from, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (skip.has(relative)) continue;
    await cloneEntry(from, to, relative, entry, skip, cloned);
  }
}

async function cloneEntry(
  from: string,
  to: string,
  relative: string,
  entry: Dirent,
  skip: ReadonlySet<string>,
  cloned: ClonedBuildTree,
): Promise<void> {
  const source = join(from, relative);
  const target = join(to, relative);

  if (entry.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (entry.isDirectory()) {
    await mkdir(target, { recursive: true });
    await chmod(target, (await lstat(source)).mode & 0o777);
    await cloneInto(from, to, relative, skip, cloned);
    return;
  }
  if (!entry.isFile()) {
    cloned.passedBy.push(relative);
    return;
  }
  await shareFile(source, target, cloned);
}

async function shareFile(source: string, target: string, cloned: ClonedBuildTree): Promise<void> {
  try {
    await link(source, target);
    return;
  } catch (err) {
    if (!COPY_INSTEAD.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
  await copyFile(source, target);
  await chmod(target, (await lstat(source)).mode & 0o777);
  cloned.sharing = 'copied';
}

/** The mode of a file, or null when there is none at that path. */
export async function fileModeOf(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
