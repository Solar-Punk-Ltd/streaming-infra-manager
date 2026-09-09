import { chmod, lchmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertExecutionId, assertExecutionRegistration, executionRootPath, type ExecutionRootRecord } from './ExecutionRoot.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, readBuildManifest } from './buildManifest.js';
import { inventoryOwnedTree, ownedTreeDigest, sha256 } from './ownedTreeInventory.js';
import { assertOwnedDirectory, assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';

export interface ExecutionCopyOptions { onProgress?: (copiedFiles: number) => Promise<void> }

/** The registered copy token is held exclusively. No script or builder may run until this copy is ready. */
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
  const source = await inventoryOwnedTree(record.source.root);
  if (ownedTreeDigest(source) !== record.source.artifactDigest) throw new Error('Execution source digest changed.');
  await readOwnedFile(record.source.root, BUILD_MANIFEST_FILE);
  await readOwnedFile(record.source.root, BUILD_COMPLETE_MARKER);
  const manifest = readBuildManifest(record.source.root).manifest;
  if (manifest?.buildId !== record.source.buildId || manifest.commit !== record.source.commit) throw new Error('Execution source build identity changed.');
  if (!isDeepStrictEqual(await inventoryOwnedTree(record.source.root), source)) throw new Error('Execution source changed during verification.');

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
    let copied = 0;
    for (const entry of source.entries) {
      if (entry.type === 'file') {
        const bytes = await readOwnedFile(record.source.root, entry.path);
        if (sha256(bytes) !== entry.sha256) throw new Error('Execution source changed during copying.');
        await writeFile(join(root, entry.path), bytes, { flag: 'wx', mode: entry.mode });
        await chmod(join(root, entry.path), entry.mode);
        await options.onProgress?.(++copied);
      } else if (entry.type === 'symlink') {
        await symlink(entry.target, join(root, entry.path));
        if (((await lstat(join(root, entry.path))).mode & 0o7777) !== entry.mode) await lchmod(join(root, entry.path), entry.mode);
      }
    }
    for (const entry of source.entries.filter(entry => entry.type === 'directory').reverse()) await chmod(join(root, entry.path), entry.mode);
    await chmod(root, source.rootMode);
    if (!isDeepStrictEqual(await inventoryOwnedTree(record.source.root), source)) throw new Error('Execution source changed during copying.');
    if (ownedTreeDigest(await inventoryOwnedTree(root)) !== record.source.artifactDigest) throw new Error('Execution copy inventory differs from its source.');
    await writeFile(join(ownerRoot, 'ready.json'), JSON.stringify({ copyToken: record.copyToken, artifactDigest: record.source.artifactDigest }), { flag: 'wx', mode: 0o600 });
    return { root, artifactDigest: record.source.artifactDigest };
  } catch (error) {
    const current = await lstat(ownerRoot).catch(() => null);
    if (current?.dev === owned.dev && current.ino === owned.ino) await rm(ownerRoot, { recursive: true, force: true });
    throw error;
  }
}
