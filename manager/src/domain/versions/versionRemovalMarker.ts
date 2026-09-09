import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stackVersionNameProblem } from '@streaming-infra-manager/common';
import { assertOwnedVersionParent } from './ownedVersionParent.js';

interface RemovalIdentity { id?: number; rootPath: string | null }
interface RemovalMarker { schema: 1; versionId: number; name: string; rootPath: string; removalId: string }
const MAX_MARKER_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNVERIFIED = 'This version removal marker cannot be verified. Resolve the interrupted removal before using this version.';
const REMOVING = 'Removal of this version has started. Finish removing it before creating another version with this name.';

function markerPath(rootPath: string): string { return `${rootPath}.removal.json`; }
function assertAnchor(rootPath: string): void {
  if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath || stackVersionNameProblem(basename(rootPath))) throw new Error(UNVERIFIED);
}

function readMarker(rootPath: string): RemovalMarker | null {
  assertAnchor(rootPath);
  if (!assertOwnedVersionParent(dirname(rootPath), true)) return null;
  const path = markerPath(rootPath);
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(UNVERIFIED);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_MARKER_BYTES)) throw new Error(UNVERIFIED);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw new Error(UNVERIFIED);
    const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (length > MAX_MARKER_BYTES || [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino ||
      info.size !== before.size || info.mode !== before.mode || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs)) throw new Error(UNVERIFIED);
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(UNVERIFIED);
    const marker = value as Record<string, unknown>;
    if (!isDeepStrictEqual(Object.keys(marker).sort(), ['name', 'removalId', 'rootPath', 'schema', 'versionId']) ||
      marker.schema !== 1 || !Number.isSafeInteger(marker.versionId) || (marker.versionId as number) < 1 ||
      marker.name !== basename(rootPath) || marker.rootPath !== rootPath || typeof marker.removalId !== 'string' || !UUID.test(marker.removalId)) throw new Error(UNVERIFIED);
    return marker as unknown as RemovalMarker;
  } finally { closeSync(fd); }
}

/** Synchronous because deployment's existing artifact admission is synchronous. Reads at most 4097 bytes. */
export function versionRemovalProblem(version: RemovalIdentity): string | null {
  if (version.rootPath === null) return null;
  try {
    const marker = readMarker(version.rootPath);
    if (!marker) return null;
    if (!Number.isSafeInteger(version.id) || version.id! < 1) return UNVERIFIED;
    if (marker.versionId > version.id!) return UNVERIFIED;
    return marker.versionId === version.id ? REMOVING : null;
  } catch { return UNVERIFIED; }
}

/** The caller holds the version row lock and has checked every hold and all owned payload paths. */
export async function persistVersionRemoval(version: { id: number; name: string; rootPath: string | null }): Promise<void> {
  const anchor = version.rootPath;
  if (!anchor || !Number.isSafeInteger(version.id) || version.id < 1 || version.name !== basename(anchor)) throw new Error(UNVERIFIED);
  assertOwnedVersionParent(dirname(anchor));
  const previous = readMarker(anchor);
  if (previous && previous.versionId > version.id) throw new Error(UNVERIFIED);
  const marker: RemovalMarker = previous?.versionId === version.id ? previous : {
    schema: 1, versionId: version.id, name: version.name, rootPath: anchor, removalId: randomUUID(),
  };
  const temporary = `${markerPath(anchor)}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let owned;
  let renamed = false;
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify(marker));
    await handle.sync();
    await handle.close();
    if (!isDeepStrictEqual(readMarker(anchor), previous)) throw new Error(UNVERIFIED);
    await rename(temporary, markerPath(anchor));
    renamed = true;
    const directory = await open(dirname(anchor), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    if (!renamed) {
      try {
        const current = await lstat(temporary, { bigint: true });
        if (owned && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) await unlink(temporary);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
