import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { getErrorMessage } from '@streaming-infra-manager/common';

/**
 * The host-owned inputs of a version root, captured for a build as one
 * committed revision.
 *
 * The base env, the deploy config and the engine envs are the operator's
 * files. The supported way to change them commits them as a set: a lock
 * around the whole edit, each file replaced atomically, and a revision
 * manifest with a generation and every file's hash written last, by rename.
 * A revision exists only when its manifest does. Capture takes the same lock,
 * with a bounded wait, reads the manifest, reads every file it lists between
 * two stats, checks each file's own format, compares every hash to the
 * manifest and refuses on any difference, naming the file. An edit paused
 * between two atomic replacements would otherwise hand capture one new file
 * and one old, both complete and valid, and no per-file check can tell.
 */

/** The commit of a revision: generation and the hash of every file in the set. */
export const CONFIG_REVISION_FILE = '.config-revision.json';

/** The lock the editor and capture share, a directory because mkdir is atomic on one kernel. */
export const CONFIG_LOCK_DIR = '.config.lock';

/** The name of the manager's editing script, for the refusals that point at it. */
export const CONFIG_EDIT_SCRIPT = 'stack-config-edit.sh';

const BASE_ENV = '.env';
const DEPLOY_DIR = 'deploy';
const DEPLOY_CONFIG = `${DEPLOY_DIR}/config.json`;
const ENGINES_DIR = 'engines';
const ENGINE_ENV = '.env';

const DEFAULT_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const STEADY_READ_RETRIES = 5;
const STEADY_READ_PAUSE_MS = 20;

export interface ConfigRevision {
  generation: number;
  /** Relative posix path to sha256 hex, for every file of the set. */
  files: Record<string, string>;
}

export interface CapturedHostConfig {
  generation: number;
  files: Map<string, Buffer>;
  /** Computed from the captured bytes, never from a second read. */
  hashes: Record<string, string>;
}

export type HostConfigCapture =
  | { captured: CapturedHostConfig; problem: null }
  | { captured: null; problem: string };

export interface CommitOptions {
  lockWaitMs?: number;
  /** Files of the set to take out of the revision, relative posix paths. */
  remove?: readonly string[];
}

export interface CaptureOptions {
  /** The keys the version's .env.sample holds, which the base env must all carry. */
  sampleEnvKeys?: readonly string[];
  lockWaitMs?: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The paths of the set a root holds, each with whether it is a regular file.
 *
 * Nothing here is followed. A link at one of these paths names bytes outside
 * the root, and the legacy tree they are taken from is writable by anything
 * that reaches the host, so a link is passed by rather than read.
 */
function hostConfigPathsIn(root: string): { relative: string; isFile: boolean }[] {
  const paths: { relative: string; isFile: boolean }[] = [];
  const consider = (relative: string): void => {
    const entry = lstatSync(join(root, relative), { throwIfNoEntry: false });
    if (entry) paths.push({ relative, isFile: entry.isFile() });
  };
  const isPlainDirectory = (relative: string): boolean =>
    lstatSync(join(root, relative), { throwIfNoEntry: false })?.isDirectory() === true;

  consider(BASE_ENV);
  if (isPlainDirectory(DEPLOY_DIR)) consider(DEPLOY_CONFIG);
  if (isPlainDirectory(ENGINES_DIR)) {
    for (const engine of readdirSync(join(root, ENGINES_DIR)).sort()) {
      if (isPlainDirectory(`${ENGINES_DIR}/${engine}`)) consider(`${ENGINES_DIR}/${engine}/${ENGINE_ENV}`);
    }
  }
  return paths;
}

/** The host-owned files a root has, relative, posix: the base env, the deploy config and every engine env. */
export function hostConfigFilesOf(root: string): string[] {
  return hostConfigPathsIn(root).filter((path) => path.isFile).map((path) => path.relative);
}

/** The paths of the set a root holds that are not regular files, so nothing reads them. */
export function hostConfigNonFilesOf(root: string): string[] {
  return hostConfigPathsIn(root).filter((path) => !path.isFile).map((path) => path.relative);
}

/**
 * Takes the edit lock, waiting up to `waitMs` for an edit under way, and
 * answers what releases it. Throws when the wait runs out, naming the lock.
 */
export async function holdHostConfigLock(
  root: string,
  waitMs = DEFAULT_LOCK_WAIT_MS,
): Promise<() => Promise<void>> {
  const lock = join(root, CONFIG_LOCK_DIR);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      return () => rmdir(lock).catch(() => undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `The host configuration in ${root} is being edited: ${CONFIG_LOCK_DIR} is held. Wait for the edit to finish, or remove a lock whose editor is gone with ${CONFIG_EDIT_SCRIPT} --unlock.`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

/** Reads a file between two stats, again when they differ, bounded. */
async function readSteady(path: string, relative: string): Promise<Buffer> {
  for (let attempt = 0; attempt < STEADY_READ_RETRIES; attempt += 1) {
    const before = await stat(path);
    const bytes = await readFile(path);
    const after = await stat(path);
    if (before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return bytes;
    }
    await sleep(STEADY_READ_PAUSE_MS);
  }
  throw new Error(`${relative} kept changing while it was read.`);
}

/** The key one line assigns, or null for a comment, a blank line or anything else. */
export function envKeyIn(line: string): string | null {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? null;
}

/** The keys an env file assigns, comments and blank lines skipped. */
export function envKeysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const key = envKeyIn(line);
    if (key) keys.add(key);
  }
  return keys;
}

const envKeysOf = (bytes: Buffer): Set<string> => envKeysIn(bytes.toString('utf8'));

/** Why the captured bytes are not a file of their kind, or null. A truncated intermediate fails here too. */
function formatProblem(relative: string, bytes: Buffer, sampleEnvKeys: readonly string[]): string | null {
  if (relative === BASE_ENV) {
    const keys = envKeysOf(bytes);
    const missing = sampleEnvKeys.filter((key) => !keys.has(key));
    if (missing.length > 0) {
      return `${BASE_ENV} lacks ${missing.join(', ')}, which this version's .env.sample has.`;
    }
    return null;
  }
  if (relative === DEPLOY_CONFIG) {
    try {
      JSON.parse(bytes.toString('utf8'));
      return null;
    } catch {
      return `${DEPLOY_CONFIG} does not parse as JSON.`;
    }
  }
  return null;
}

/** The committed revision of a root, or null for a root without one. Throws on a manifest that does not parse. */
export async function readHostConfigRevision(root: string): Promise<ConfigRevision | null> {
  return readRevision(root);
}

async function readRevision(root: string): Promise<ConfigRevision | null> {
  const path = join(root, CONFIG_REVISION_FILE);
  if (!existsSync(path)) return null;
  const bytes = await readFile(path);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error(`${CONFIG_REVISION_FILE} does not parse as a revision.`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(`${CONFIG_REVISION_FILE} does not parse as a revision.`);
  const record = raw as { generation?: unknown; files?: unknown };
  if (!Number.isInteger(record.generation) || typeof record.files !== 'object' || record.files === null) {
    throw new Error(`${CONFIG_REVISION_FILE} does not parse as a revision.`);
  }
  return { generation: record.generation as number, files: record.files as Record<string, string> };
}

/** The mode a settings file gets when there is no file yet to take one from. */
const OWNER_ONLY_MODE = 0o600;

/** The mode of an existing file, or owner only for a file that does not exist yet. */
async function modeToKeep(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return OWNER_ONLY_MODE;
    throw err;
  }
}

/**
 * Written to a temporary name beside the target, then renamed over it.
 *
 * Every file of the set holds secrets, and the versions root above them is
 * readable by anyone on the host, so a new file is owner only and a replaced
 * one keeps the mode it had. The temporary file never exists at a wider mode
 * than the one it ends at, whatever the umask of the process is.
 */
async function replaceAtomically(path: string, bytes: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, bytes, { mode: OWNER_ONLY_MODE });
  try {
    await chmod(temp, await modeToKeep(path));
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

async function writeRevision(root: string, revision: ConfigRevision): Promise<void> {
  await replaceAtomically(
    join(root, CONFIG_REVISION_FILE),
    Buffer.from(`${JSON.stringify(revision, null, 2)}\n`, 'utf8'),
  );
}

/** The committed revision of a root, or why there is none to capture. */
export async function captureHostConfig(
  root: string,
  options: CaptureOptions = {},
): Promise<HostConfigCapture> {
  let release: () => Promise<void>;
  try {
    release = await holdHostConfigLock(root, options.lockWaitMs);
  } catch (err) {
    return { captured: null, problem: getErrorMessage(err) };
  }
  try {
    const revision = await readRevision(root);
    if (!revision) {
      return {
        captured: null,
        problem: `${root} has no committed revision of its host configuration. Commit one with ${CONFIG_EDIT_SCRIPT}.`,
      };
    }
    for (const relative of hostConfigFilesOf(root)) {
      if (!(relative in revision.files)) {
        return {
          captured: null,
          problem: `${relative} is not in the committed revision. Commit it with ${CONFIG_EDIT_SCRIPT}.`,
        };
      }
    }
    const files = new Map<string, Buffer>();
    const hashes: Record<string, string> = {};
    for (const [relative, committed] of Object.entries(revision.files)) {
      const path = join(root, relative);
      if (!existsSync(path)) {
        return { captured: null, problem: `${relative} is in the committed revision but missing from ${root}.` };
      }
      const bytes = await readSteady(path, relative);
      const actual = sha256(bytes);
      if (actual !== committed) {
        return {
          captured: null,
          problem: `${relative} does not match the committed revision. Commit the edit with ${CONFIG_EDIT_SCRIPT}, or put the committed file back.`,
        };
      }
      const problem = formatProblem(relative, bytes, options.sampleEnvKeys ?? []);
      if (problem) return { captured: null, problem };
      files.set(relative, bytes);
      hashes[relative] = actual;
    }
    return { captured: { generation: revision.generation, files, hashes }, problem: null };
  } catch (err) {
    return { captured: null, problem: getErrorMessage(err) };
  } finally {
    await release();
  }
}

/**
 * The supported edit, as the manager's own writers make it: under the lock,
 * each given file replaced atomically, then the manifest of the whole set
 * written last, one generation up.
 */
export async function commitHostConfig(
  root: string,
  files: Record<string, Buffer>,
  options: CommitOptions = {},
): Promise<ConfigRevision> {
  return withHostConfigLock(root, (commit) => commit(files, options), options.lockWaitMs);
}

/** Commits a set of files into a root whose lock the caller already holds. */
export type CommitUnderLock = (files: Record<string, Buffer>, options?: CommitOptions) => Promise<ConfigRevision>;

/**
 * Runs one edit under one acquisition of the lock.
 *
 * A caller that reads a file and then commits what it read has to hold the
 * lock across both, because an editor that got in between leaves it writing
 * back bytes that are already stale, and the manifest carries no expected
 * generation to catch that.
 */
export async function withHostConfigLock<T>(
  root: string,
  body: (commit: CommitUnderLock) => Promise<T>,
  waitMs?: number,
): Promise<T> {
  const release = await holdHostConfigLock(root, waitMs);
  try {
    return await body((files, options = {}) => commitHeldHostConfig(root, files, options));
  } finally {
    await release();
  }
}

async function commitHeldHostConfig(
  root: string,
  files: Record<string, Buffer>,
  options: CommitOptions,
): Promise<ConfigRevision> {
  const current = await readRevision(root);
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(join(root, relative, '..'), { recursive: true });
    await replaceAtomically(join(root, relative), bytes);
  }
  for (const relative of options.remove ?? []) {
    await rm(join(root, relative), { force: true });
  }
  const revision = await revisionOfPresentFiles(root, (current?.generation ?? 0) + 1);
  await writeRevision(root, revision);
  return revision;
}

async function revisionOfPresentFiles(root: string, generation: number): Promise<ConfigRevision> {
  const hashes: Record<string, string> = {};
  for (const relative of hostConfigFilesOf(root)) {
    hashes[relative] = sha256(await readFile(join(root, relative)));
  }
  return { generation, files: hashes };
}

/**
 * The migration: a root without a manifest gets generation one from its
 * current bytes, because nothing older exists to compare against. Answers
 * the revision written, or null for a root that already has one.
 *
 * Commits through the lock its caller holds, because a caller that already
 * decided something about the root under that lock would otherwise decide it
 * again against a root an editor changed in between.
 */
export async function adoptHostConfig(
  root: string,
  commit: CommitUnderLock,
): Promise<ConfigRevision | null> {
  if (await readRevision(root)) return null;
  return commit({});
}
