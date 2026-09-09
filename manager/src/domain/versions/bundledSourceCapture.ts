import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureHostConfig, CONFIG_LOCK_DIR, CONFIG_REVISION_FILE, envKeysIn } from './hostConfigCapture.js';
import { isHostInputPath, ownedHostInputPaths } from './hostInputPaths.js';
import { assertOwnedDirectory, assertOwnedLinkTarget, assertOwnedTreeLinks, assertRelativeTreePath, assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';

export type GitReadCommand = (root: string, args: readonly string[]) => Promise<Buffer>;
export interface PinnedBundledSource { root: string; commit: string }
export interface BundledInputIdentity { generation: number; hashes: Record<string, string> }

const gitRead: GitReadCommand = (root, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error(`Git source capture failed during ${args[0]}.`));
    else resolve(stdout);
  });
});

function decode(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function isObjectId(value: string): boolean { return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value); }

function assertCleanApplication(status: string): void {
  const entries = status.split('\0');
  const allowed = (path: string) => isHostInputPath(path) || path === CONFIG_REVISION_FILE || path === CONFIG_LOCK_DIR + '/';
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ' || !allowed(entry.slice(3))) throw new Error('Application has uncommitted changes.');
    if (/[RC]/.test(entry.slice(0, 2)) && !allowed(entries[++index] ?? '')) throw new Error('Application has uncommitted changes.');
  }
}

async function makeParents(root: string, path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === '.') return;
  for (const part of parent.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) {
    try { await mkdir(join(root, part)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertOwnedDirectory(root, part);
  }
}

async function exportCommit(source: string, destination: string, commit: string, run: GitReadCommand): Promise<void> {
  const tree = decode(await run(source, ['ls-tree', '-rz', '--full-tree', commit]));
  const links: { path: string; target: string }[] = [];
  for (const entry of tree.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, separator).split(' ');
    const path = entry.slice(separator + 1);
    if (separator < 0 || !object || !isObjectId(object)) throw new Error('Invalid Git tree entry.');
    assertRelativeTreePath(path);
    await makeParents(destination, path);
    if (mode === '160000' && type === 'commit') {
      await assertOwnedDirectory(source, path);
      await mkdir(join(destination, path));
      assertCleanApplication(decode(await run(join(source, path), ['status', '--porcelain=v1', '-z', '--untracked-files=all'])));
      await exportCommit(join(source, path), join(destination, path), object, run);
    } else if (type === 'blob' && ['100644', '100755', '120000'].includes(mode!)) {
      const bytes = await run(source, ['cat-file', 'blob', object]);
      if (mode === '120000') {
        const target = decode(bytes);
        assertOwnedLinkTarget(destination, path, target);
        links.push({ path, target });
      } else {
        await writeFile(join(destination, path), bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
        await chmod(join(destination, path), mode === '100755' ? 0o755 : 0o644);
      }
    } else throw new Error('Unsupported Git tree entry.');
  }
  for (const { path, target } of links) await symlink(target, join(destination, path));
}

/** Exports Git objects from one resolved commit. No build command reads the mutable checkout. */
export async function exportPinnedBundledSource(
  source: string,
  destination: string,
  run: GitReadCommand = gitRead,
): Promise<PinnedBundledSource> {
  await assertSeparateOwnedTrees(source, destination);
  await assertOwnedDirectory(source);
  const commit = decode(await run(source, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!isObjectId(commit)) throw new Error('Git did not return a complete commit id.');
  assertCleanApplication(decode(await run(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])));
  await mkdir(destination);
  try {
    await exportCommit(source, destination, commit, run);
    await assertOwnedTreeLinks(destination);
    return { root: destination, commit };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Replaces the complete input set only inside an exclusively owned exported tree. */
export async function captureBundledInputs(
  source: string,
  destination: string,
  options: { lockWaitMs?: number } = {},
): Promise<BundledInputIdentity> {
  await assertSeparateOwnedTrees(source, destination);
  await assertOwnedDirectory(destination);
  const previous = await ownedHostInputPaths(destination);
  let hasRevision = false;
  try {
    await lstat(join(destination, CONFIG_REVISION_FILE));
    await readOwnedFile(destination, CONFIG_REVISION_FILE);
    hasRevision = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let sampleEnvKeys: string[] = [];
  try {
    await lstat(join(destination, '.env.sample'));
    sampleEnvKeys = [...envKeysIn(decode(await readOwnedFile(destination, '.env.sample')))];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = await captureHostConfig(source, { ...options, sampleEnvKeys, strictPaths: true });
  if (!result.captured) throw new Error(result.problem);
  const { generation, hashes, files } = result.captured;
  for (const path of previous) await rm(join(destination, path));
  for (const [path, bytes] of files) {
    await makeParents(destination, path);
    await writeFile(join(destination, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  if (hasRevision) await rm(join(destination, CONFIG_REVISION_FILE));
  await writeFile(join(destination, CONFIG_REVISION_FILE), JSON.stringify({ generation, files: hashes }) + '\n', { flag: 'wx', mode: 0o600 });
  return { generation, hashes };
}
