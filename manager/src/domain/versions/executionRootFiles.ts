import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertExecutionId, assertExecutionRegistration, executionRootPath, type ExecutionRootRecord } from './ExecutionRoot.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, readBuildManifest } from './buildManifest.js';
import { COPY_INSTEAD } from './buildTreeClone.js';
import { inventoryOwnedTree, ownedTreeDigest, pathStamp, stampOwnedTree, type OwnedTreeInventory } from './ownedTreeInventory.js';
import { assertOwnedDirectory, assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';

export interface ExecutionCopyOptions {
  onProgress?: (copiedFiles: number) => Promise<void>;
  /**
   * The inventory the caller has already taken of this source, rather than one
   * taken again here.
   *
   * Reading and hashing the build tree is what preparing a copy costs, and the
   * caller that registers the execution has to take one anyway to know the
   * digest it registers. What proves the tree has not moved since is its
   * stamps, so nothing is given up by trusting the inventory it came with.
   */
  sourceInventory?: OwnedTreeInventory;
}

/**
 * Puts the build's file at a path of the copy's own, answering whether the two
 * paths are now the one inode.
 *
 * A filesystem that will not link, because the copy is on another volume from
 * the build or because it holds too many links already, gets the bytes.
 */
async function shareOrCopyFile(from: string, to: string, mode: number): Promise<boolean> {
  try {
    await link(from, to);
    return true;
  } catch (err) {
    if (!COPY_INSTEAD.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await chmod(to, mode);
  return false;
}

/**
 * The registered copy token is held exclusively. No script or builder may run until this copy is ready.
 *
 * The copy's regular files are hard links to the build's, the way one build is
 * cloned from another, because a published build is never written to again and
 * the files a deployment writes are ones the build does not have.
 *
 * Every link moves the build inode's status-change time, so what the build is
 * compared against when the copy is made is the stamp read back through the
 * copy's own path. That is the same inode, so the one comparison says both that
 * the build did not move and that the copy holds the very file the inventory
 * read.
 */
export async function copyExecutionRoot(
  input: ExecutionRootRecord,
  executionsParent: string,
  options: ExecutionCopyOptions = {},
): Promise<{ root: string; artifactDigest: string }> {
  const record = structuredClone(input);
  assertExecutionRegistration(record);
  if (record.state !== 'copying' || record.copyToken === null || record.project !== record.profile.name) throw new Error('Execution has no exclusive copy ownership.');
  assertExecutionId(record.copyToken);
  const root = executionRootPath(executionsParent, record.executionId);
  if (record.root !== root) throw new Error('Execution root differs from its configured UUID path.');
  await assertOwnedDirectory(executionsParent);
  const ownerRoot = dirname(root);
  await assertSeparateOwnedTrees(record.source.root, ownerRoot);
  const source = options.sourceInventory ? structuredClone(options.sourceInventory) : await inventoryOwnedTree(record.source.root);
  if (ownedTreeDigest(source) !== record.source.artifactDigest) throw new Error('Execution source digest changed.');
  await readOwnedFile(record.source.root, BUILD_MANIFEST_FILE);
  await readOwnedFile(record.source.root, BUILD_COMPLETE_MARKER);
  const manifest = readBuildManifest(record.source.root).manifest;
  if (manifest?.buildId !== record.source.buildId || manifest.commit !== record.source.commit) throw new Error('Execution source build identity changed.');
  if (!isDeepStrictEqual(await stampOwnedTree(record.source.root), source.stamps)) throw new Error('Execution source changed during verification.');

  await mkdir(ownerRoot, { mode: 0o700 });
  const owned = await lstat(ownerRoot);
  try {
    await chmod(ownerRoot, 0o700);
    const owner = {
      executionId: record.executionId, copyToken: record.copyToken, source: record.source, profile: record.profile,
      jobReferenceId: record.jobReferenceId, target: record.target, project: record.project, action: record.action,
      services: record.services, referenceId: record.referenceId,
    };
    await writeFile(join(ownerRoot, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await mkdir(root, { mode: 0o700 });
    for (const entry of source.entries.filter(entry => entry.type === 'directory')) await mkdir(join(root, entry.path), { mode: 0o700 });
    const shared: string[] = [];
    let copied = 0;
    for (const entry of source.entries) {
      if (entry.type === 'file') {
        if (await shareOrCopyFile(join(record.source.root, entry.path), join(root, entry.path), entry.mode)) shared.push(entry.path);
        await options.onProgress?.(++copied);
      } else if (entry.type === 'symlink') {
        await symlink(entry.target, join(root, entry.path));
      }
    }
    for (const entry of source.entries.filter(entry => entry.type === 'directory').reverse()) await chmod(join(root, entry.path), entry.mode);
    await chmod(root, source.rootMode);
    const expected = { ...source.stamps };
    for (const path of shared) expected[path] = await pathStamp(join(root, path));
    if (!isDeepStrictEqual(await stampOwnedTree(record.source.root), expected)) throw new Error('Execution source changed during copying.');
    if (ownedTreeDigest(await inventoryOwnedTree(root)) !== record.source.artifactDigest) throw new Error('Execution copy inventory differs from its source.');
    await writeFile(join(ownerRoot, 'ready.json'), JSON.stringify({ copyToken: record.copyToken, artifactDigest: record.source.artifactDigest }), { flag: 'wx', mode: 0o600 });
    return { root, artifactDigest: record.source.artifactDigest };
  } catch (error) {
    const current = await lstat(ownerRoot).catch(() => null);
    if (current?.dev === owned.dev && current.ino === owned.ino) await rm(ownerRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Removes one copy and the ownership files beside it, and nothing else.
 *
 * The directory is never taken from the record: it is rebuilt from the
 * configured parent and the execution's own UUID, so a record that names any
 * other path is refused rather than followed. `owner.json` is the second
 * reading of the same question. A copy that never finished has none, and one
 * that cannot be read says nothing either way, so both remove. Only a file
 * that parses and names a different execution refuses, because that directory
 * is somebody else's.
 */
export async function removeExecutionRoot(input: ExecutionRootRecord, executionsParent: string): Promise<void> {
  const record = structuredClone(input);
  assertExecutionRegistration(record);
  const root = executionRootPath(executionsParent, record.executionId);
  if (record.root !== root) throw new Error('Execution root differs from its configured UUID path.');
  const ownerRoot = dirname(root);
  const owned = await readOwnedFile(ownerRoot, 'owner.json')
    .then(bytes => (JSON.parse(bytes.toString('utf8')) as { executionId?: unknown }).executionId)
    .catch(() => undefined);
  if (owned !== undefined && owned !== record.executionId) throw new Error('The owner file names another execution.');
  await rm(ownerRoot, { recursive: true, force: true });
}
