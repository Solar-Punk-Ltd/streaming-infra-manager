import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function assertSeparateOwnedTrees(source: string, destination: string): Promise<void> {
  const sourcePath = await realpath(source);
  let destinationPath: string;
  try { destinationPath = await realpath(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    destinationPath = join(await realpath(dirname(destination)), basename(destination));
  }
  const outside = (path: string) => path === '..' || path.startsWith(`..${sep}`);
  if (!outside(relative(sourcePath, destinationPath)) || !outside(relative(destinationPath, sourcePath))) {
    throw new Error('Bundled capture requires separate source and private trees.');
  }
}

export function assertRelativeTreePath(path: string): void {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid owned-tree path.');
  }
}

export function assertOwnedLinkTarget(root: string, path: string, target: string): void {
  assertRelativeTreePath(path);
  const destination = relative(resolve(root), resolve(root, dirname(path), target));
  if (!target || target.includes('\0') || target.includes('\\') || isAbsolute(target) ||
      destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
    throw new Error('Symbolic link target escapes the owned tree.');
  }
}

/** Resolve links as the filesystem does, expanding each link before applying a following `..`. */
export async function assertOwnedTreeLinks(root: string): Promise<void> {
  const links = new Map<string, string>();
  async function collect(directory: string): Promise<void> {
    await assertOwnedDirectory(root, directory);
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      assertRelativeTreePath(path);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) links.set(path, await readlink(join(root, path)));
      else if (info.isDirectory()) await collect(path);
    }
  }
  await collect('');
  for (const path of links.keys()) {
    const pending = path.split('/');
    const resolved: string[] = [];
    let expansions = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!resolved.length) throw new Error('Symbolic link target escapes the owned tree.');
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, part].join('/');
      const target = links.get(candidate);
      if (target === undefined) resolved.push(part);
      else {
        if (++expansions > 40) throw new Error('Symbolic link chain is cyclic or exceeds the resolution limit.');
        if (!target || target.includes('\0') || target.includes('\\') || isAbsolute(target)) {
          throw new Error('Symbolic link target escapes the owned tree.');
        }
        pending.unshift(...target.split('/'));
      }
    }
  }
}

/** The caller owns the tree. Ancestors must be real directories, never link traversal. */
export async function assertOwnedDirectory(root: string, path = ''): Promise<void> {
  if (path) assertRelativeTreePath(path);
  for (const candidate of ['', ...(path ? path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : [])]) {
    const info = await lstat(join(root, candidate));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Owned-tree directory is missing or is a symbolic link.');
  }
}

export async function readOwnedFile(root: string, path: string): Promise<Buffer> {
  return readOwnedFileWith(root, path, true);
}

/**
 * Reads a regular file from an immutable tree whose files may be hard linked elsewhere.
 *
 * Creating or removing another link changes ctime on the shared inode without changing
 * its bytes or durable identity. Mutable and exclusively owned trees keep using the
 * stricter `readOwnedFile` check above.
 */
export async function readSharedOwnedFile(root: string, path: string): Promise<Buffer> {
  return readOwnedFileWith(root, path, false);
}

async function readOwnedFileWith(root: string, path: string, compareCtime: boolean): Promise<Buffer> {
  assertRelativeTreePath(path);
  const parent = dirname(path);
  await assertOwnedDirectory(root, parent === '.' ? '' : parent);
  const fullPath = join(root, path);
  const before = await lstat(fullPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Owned-tree file is not a regular file or is a symbolic link.');
  const unchanged = (info: typeof before): boolean => info.isFile() && !info.isSymbolicLink() &&
    info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mode === before.mode &&
    info.mtimeNs === before.mtimeNs && (!compareCtime || info.ctimeNs === before.ctimeNs);
  const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!unchanged(opened)) throw new Error('Owned-tree file changed while opening.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(fullPath, { bigint: true });
    await assertOwnedDirectory(root, parent === '.' ? '' : parent);
    if ([after, current].some(info => !unchanged(info))) {
      throw new Error('Owned-tree file changed while reading.');
    }
    return bytes;
  } finally { await handle.close(); }
}
