import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from '../Logger.js';

import {
  durablePathStamp,
  FILE_TYPE_BITS,
  FILE_TYPE_MASK,
  inventoryOwnedTree,
  modeOfStamp,
  ownedTreeDigest,
  type OwnedTreeEntry,
  type RecordedOwnedTree,
} from './ownedTreeInventory.js';
import { assertOwnedDirectory } from './ownedTreePaths.js';

const logger = Logger.getInstance();

const RECORD_SUFFIX = '.inventory.json';
const PENDING_SUFFIX = '.pending';
const RECORD_FORMAT = 1;
const SHA256 = /^[a-f0-9]{64}$/;

export interface BuildInventoryRecord extends RecordedOwnedTree {
  format: typeof RECORD_FORMAT;
  buildId: string;
  digest: string;
}

export interface BuildInventory {
  record: BuildInventoryRecord;
  /** True when this call read and hashed the build, rather than answering from the record beside it. */
  hashed: boolean;
  tookMs: number;
}

/**
 * Where a build's inventory is kept: beside the build directory, never in it.
 *
 * A published build is never written to again, which is the whole reason its
 * bytes can be hashed once, so a record inside the tree would change the tree
 * it describes. The database has no row per build to carry a column either,
 * only the current and previous build ids on the version row. A build id is a
 * commit with an optional `-r<n>` and carries no dot, so this name can never
 * be another build's directory, and prune, which only removes entries whose
 * name is a build id, passes over it.
 */
export const buildInventoryRecordPath = (buildRoot: string): string => `${buildRoot}${RECORD_SUFFIX}`;

function isOwnedTreeEntry(raw: unknown): raw is OwnedTreeEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.path !== 'string' || !entry.path || !Number.isInteger(entry.mode)) return false;
  if (entry.type === 'directory') return true;
  if (entry.type === 'file') return typeof entry.sha256 === 'string' && SHA256.test(entry.sha256);
  return entry.type === 'symlink' && typeof entry.target === 'string';
}

/**
 * Whether an entry says the same thing about a path as the stamp taken of it.
 *
 * The stamps prove which file each path is and the entries say what the copy
 * builds there, so nothing holds the two together unless this does. A record
 * that keeps every stamp and re-declares a regular file of the build as a
 * symbolic link, or gives it another mode, would otherwise parse, and the copy
 * would be built the way the record said.
 *
 * A symbolic link's mode is recorded as 0o777 whatever the platform gave it,
 * so for a link only the type can be held to the stamp.
 */
function agreesWithStamp(entry: { mode: number; type: OwnedTreeEntry['type'] }, stamp: string | undefined): boolean {
  const mode = stamp === undefined ? null : modeOfStamp(stamp);
  if (mode === null || (mode & FILE_TYPE_MASK) !== FILE_TYPE_BITS[entry.type]) return false;
  return entry.type === 'symlink' || (mode & 0o7777) === entry.mode;
}

/**
 * The record these bytes hold, or null for anything that is not one of this
 * build's.
 *
 * The digest is recomputed rather than believed, the stamps and the entries
 * have to name the same paths and agree about each one, and the root has to be
 * stamped as the directory whose mode the record gives. The stamps are what a
 * later copy proves the build by, so a path either side holds alone is a path
 * that copy would prove by nothing at all.
 */
export function parseBuildInventoryRecord(bytes: Buffer, buildId: string): BuildInventoryRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const { format, entries, rootMode, durableStamps, digest } = record;
  if (format !== RECORD_FORMAT || record.buildId !== buildId || typeof digest !== 'string' ||
      !Number.isInteger(rootMode) || !Array.isArray(entries) || !entries.every(isOwnedTreeEntry) ||
      typeof durableStamps !== 'object' || durableStamps === null) {
    return null;
  }
  const unchecked = durableStamps as Record<string, unknown>;
  if (!Object.values(unchecked).every(stamp => typeof stamp === 'string')) return null;
  const stamped = unchecked as Record<string, string>;
  if (Object.keys(stamped).length !== entries.length + 1) return null;
  if (!agreesWithStamp({ mode: rootMode as number, type: 'directory' }, stamped[''])) return null;
  if (!entries.every(entry => agreesWithStamp(entry, stamped[entry.path]))) return null;
  const parsed: BuildInventoryRecord = {
    format: RECORD_FORMAT,
    buildId,
    digest,
    rootMode: rootMode as number,
    entries: entries as OwnedTreeEntry[],
    durableStamps: stamped,
  };
  return ownedTreeDigest(parsed) === digest ? parsed : null;
}

const errnoOf = (err: unknown): string | null => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : null;
};

/**
 * The record's bytes, or null for every reason there might not be any.
 *
 * Nothing here follows a link or reads through one, the way everything else
 * that touches an owned tree does not. Nothing here fails a deploy either: a
 * record is a saving and never a dependency, so a filesystem that will not hand
 * it over costs the build a reading and says so, the same way one that will not
 * take the record back costs the next deploy one. Only an error with no errno,
 * which is a mistake in this file rather than an answer from the filesystem,
 * is raised.
 */
async function recordBytes(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } catch (err) {
    const code = errnoOf(err);
    if (code === null) throw err;
    if (code !== 'ENOENT') logger.warn(`[Executions] the inventory record ${path} could not be read (${code}). Its build is read again.`);
    return null;
  } finally { await handle?.close(); }
}

export async function readBuildInventoryRecord(buildRoot: string): Promise<BuildInventoryRecord | null> {
  const bytes = await recordBytes(buildInventoryRecordPath(buildRoot));
  return bytes === null ? null : parseBuildInventoryRecord(bytes, basename(buildRoot));
}

/**
 * Writes the record under a name only this call owns and renames it over the
 * record's own, so a crash part way through leaves a file nobody reads rather
 * than a record that parses as far as the truncation.
 */
async function writeBuildInventoryRecord(buildRoot: string, record: BuildInventoryRecord): Promise<void> {
  const path = buildInventoryRecordPath(buildRoot);
  const pending = `${path}.${randomUUID()}${PENDING_SUFFIX}`;
  try {
    await writeFile(pending, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(pending, path);
  } catch (err) {
    await unlink(pending).catch(() => undefined);
    throw err;
  }
}

/** The build a file beside the builds names, or null when the file is not a record of one. */
function buildOfRecordName(name: string): string | null {
  const at = name.indexOf(RECORD_SUFFIX);
  if (at <= 0) return null;
  const rest = name.slice(at + RECORD_SUFFIX.length);
  return rest === '' || rest.endsWith(PENDING_SUFFIX) ? name.slice(0, at) : null;
}

/**
 * Removes the records of builds that are gone, and the half written ones a
 * crashed writer left beside them.
 *
 * Prune removes a build directory and passes over everything beside it whose
 * name is not a build id, so without this the record of a pruned build would
 * sit there for the life of the host.
 */
export async function forgetRecordsOfGoneBuilds(buildsParent: string): Promise<void> {
  for (const name of await readdir(buildsParent)) {
    const build = buildOfRecordName(name);
    if (build === null) continue;
    const gone = await lstat(join(buildsParent, build)).then(info => !info.isDirectory(), () => true);
    if (gone) await unlink(join(buildsParent, name)).catch(() => undefined);
  }
}

/**
 * The build's inventory: read and hashed the first time anything asks for one,
 * and answered from the record beside the build every time after that.
 *
 * Hashing a build is what preparing a deployment's private copy used to cost,
 * about two minutes for the 43,000 files of the real stack, once per member of
 * a pool. A published build is never written to again, so one hashing is the
 * only one its bytes can need. A build published before this existed has no
 * record and gets one here, so nothing has to be done by hand for it.
 *
 * A record is only this build's while this build is the directory it was taken
 * of. A pruned build leaves its record beside the builds, and the same build id
 * comes back when an operator rolls back to that commit, so the record's own
 * stamp of the build root is read back before it is believed. A directory that
 * was made again is another inode with another modification time, and is
 * inventoried again.
 *
 * A record that cannot be written is a warning and not a failure: the deploy
 * goes ahead on the inventory this call took, and the next one takes another.
 */
export async function buildInventory(buildRoot: string): Promise<BuildInventory> {
  const started = Date.now();
  const existing = await readBuildInventoryRecord(buildRoot);
  if (existing && existing.durableStamps[''] === await durablePathStamp(buildRoot)) {
    return { record: existing, hashed: false, tookMs: Date.now() - started };
  }
  const taken = await inventoryOwnedTree(buildRoot);
  const record: BuildInventoryRecord = {
    format: RECORD_FORMAT,
    buildId: basename(buildRoot),
    digest: ownedTreeDigest(taken),
    rootMode: taken.rootMode,
    entries: taken.entries,
    durableStamps: taken.durableStamps,
  };
  try {
    await assertOwnedDirectory(dirname(buildRoot));
    await writeBuildInventoryRecord(buildRoot, record);
    await forgetRecordsOfGoneBuilds(dirname(buildRoot));
  } catch (err) {
    logger.warn(`[Executions] the inventory of ${buildRoot} was not recorded: ${getErrorMessage(err)}. The next copy of this build reads it again.`);
  }
  return { record, hashed: true, tookMs: Date.now() - started };
}
