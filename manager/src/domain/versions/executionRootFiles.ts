import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertExecutionId, assertExecutionRegistration, executionRootPath, type ExecutionRootRecord } from './ExecutionRoot.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, readBuildManifest } from './buildManifest.js';
import { COPY_INSTEAD } from './buildTreeClone.js';
import { hostConfigFilesOf } from './hostConfigCapture.js';
import {
  durableStampOwnedTree,
  inodeOfStamp,
  inventoryLinkedTree,
  inventoryOwnedTree,
  ownedTreeDigest,
  sha256,
  type FileDigestSource,
  type RecordedOwnedTree,
} from './ownedTreeInventory.js';
import { assertOwnedDirectory, assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';

export interface ExecutionCopyOptions {
  onProgress?: (copiedFiles: number) => Promise<void>;
  /**
   * The inventory the caller holds of this source, rather than one taken again
   * here.
   *
   * Reading and hashing the build tree is what preparing a copy costs, and the
   * caller that registers the execution has to hold one anyway to know the
   * digest it registers. What proves the tree has not moved since is its
   * stamps, so nothing is given up by trusting the inventory it came with,
   * whether that was taken a moment ago or recorded when the build was first
   * copied from.
   */
  sourceInventory?: RecordedOwnedTree;
  /**
   * Where that inventory was read from, named in a refusal.
   *
   * A source proved against a record that no longer describes it is refused on
   * every deploy until one of the two is put right, and without this the
   * refusal says neither that a record exists nor where it is.
   */
  sourceInventoryPath?: string;
}

async function copyFileInto(from: string, to: string, mode: number): Promise<void> {
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await chmod(to, mode);
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
  await copyFileInto(from, to, mode);
  return false;
}

/**
 * How the finished copy is proved to be the build, without reading the build a
 * second time.
 *
 * A file the copy linked is the build's own inode, and one inode is one set of
 * bytes, so the device and inode the record stamped is the whole proof of that
 * file. A linked path that has stopped being that inode is refused rather than
 * hashed, because what the copy was given is what it has to still hold. Only
 * the files the copy owns outright are read: the settings files, copied so that
 * a deploy writing one does not write the build, and every file on a host whose
 * filesystem refused the link.
 *
 * A path the stamps do not hold is read too. Assigning `__proto__` as a key of
 * a plain object sets a prototype instead, so a build carrying a file of that
 * name has one path with no identity to be compared by, and its bytes answer
 * for it the way they did before any of this was recorded.
 */
function copiedFileDigest(root: string, source: RecordedOwnedTree, ownFiles: ReadonlySet<string>): FileDigestSource {
  const recorded = new Map(source.entries.flatMap(entry => entry.type === 'file' ? [[entry.path, entry.sha256] as const] : []));
  return async (path, durable) => {
    const known = recorded.get(path);
    const stamped = source.durableStamps[path];
    if (known === undefined || ownFiles.has(path) || typeof stamped !== 'string') return sha256(await readOwnedFile(root, path));
    if (inodeOfStamp(durable) !== inodeOfStamp(stamped)) throw new Error('Execution copy inventory differs from its source.');
    return known;
  };
}

/**
 * The registered copy token is held exclusively. No script or builder may run until this copy is ready.
 *
 * The copy's regular files are hard links to the build's, the way one build is
 * cloned from another, because a published build is never written to again and
 * the files a deployment writes are ones the build does not have.
 *
 * The settings files are the exception, so they are copied. A build carries
 * whichever of them its version had committed when it was published, and they
 * are the ones a deploy reaches for: `bootstrapStackDefaults` narrows the base
 * env's mode in the copy on every deploy, and the stack's scripts write the
 * per-profile files beside them. A chmod or a truncation through a link is one
 * on the build, which would change the digest the build is admitted on.
 *
 * Every link moves the build inode's status-change time and its link count,
 * which is why the stamps compared either side of the copy are the durable
 * ones. A build the copy has linked from is a build the copy has not changed.
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
  const sourceChanged = (during: string) => new Error(`Execution source changed during ${during}.${options.sourceInventoryPath
    ? ` It was proved against ${options.sourceInventoryPath}, which is removed to have the source read again.` : ''}`);
  if (!isDeepStrictEqual(await durableStampOwnedTree(record.source.root), source.durableStamps)) throw sourceChanged('verification');

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
    const settings = new Set(hostConfigFilesOf(record.source.root));
    const ownFiles = new Set<string>();
    let copied = 0;
    for (const entry of source.entries) {
      if (entry.type === 'file') {
        const from = join(record.source.root, entry.path);
        const to = join(root, entry.path);
        if (settings.has(entry.path)) {
          await copyFileInto(from, to, entry.mode);
          ownFiles.add(entry.path);
        } else if (!(await shareOrCopyFile(from, to, entry.mode))) ownFiles.add(entry.path);
        await options.onProgress?.(++copied);
      } else if (entry.type === 'symlink') {
        await symlink(entry.target, join(root, entry.path));
      }
    }
    for (const entry of source.entries.filter(entry => entry.type === 'directory').reverse()) await chmod(join(root, entry.path), entry.mode);
    await chmod(root, source.rootMode);
    if (!isDeepStrictEqual(await durableStampOwnedTree(record.source.root), source.durableStamps)) throw sourceChanged('copying');
    const copy = await inventoryLinkedTree(root, copiedFileDigest(root, source, ownFiles));
    if (ownedTreeDigest(copy) !== record.source.artifactDigest) throw new Error('Execution copy inventory differs from its source.');
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
