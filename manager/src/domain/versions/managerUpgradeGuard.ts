import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertOwnedVersionParent } from './ownedVersionParent.js';

const MAX_RECORD_BYTES = 32768;
const UNVERIFIED = 'Manager upgrade ownership cannot be verified.';

/** What a rerun is told when a directory an earlier upgrade left is still there. */
export const UPGRADE_ALREADY_OWNED = 'Manager upgrade is already owned or in progress.';

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('../') && path !== '..' && !isAbsolute(path));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readRecord(path: string): unknown | null {
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return null; throw new Error(UNVERIFIED); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_RECORD_BYTES)) throw new Error(UNVERIFIED);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(UNVERIFIED);
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true }); const current = lstatSync(path, { bigint: true });
    if (length > MAX_RECORD_BYTES || [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino ||
      info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs)) throw new Error(UNVERIFIED);
    try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); } catch { throw new Error(UNVERIFIED); }
  } finally { closeSync(fd); }
}

function atomicRecord(path: string, record: unknown): void {
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new Error(UNVERIFIED);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const owned = fstatSync(fd, { bigint: true });
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try {
      const current = lstatSync(temporary, { bigint: true });
      if (current.dev === owned.dev && current.ino === owned.ino && current.isFile()) unlinkSync(temporary);
    } catch (error) { if (!missing(error)) throw error; }
  }
}

/** A retained directory always blocks acquisition, including a crash before owner.json was written. */
export class ManagerUpgradeGuard {
  private readonly ownerId = randomUUID();
  private record: unknown;

  constructor(private readonly root: string, mutableRoot: string) {
    for (const path of [root, mutableRoot]) if (!isAbsolute(path) || resolve(path) !== path) throw new Error(UNVERIFIED);
    // All supported paths are physical except verified OS aliases. Compare their canonical lexical form too.
    const physical = (path: string) => process.platform === 'darwin' ? path.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : path;
    if (inside(physical(mutableRoot), physical(root)) ||
      inside(physical(root), physical(mutableRoot))) throw new Error('Manager upgrade guard must be outside the mutable installation.');
    assertOwnedVersionParent(mutableRoot, true);
    assertOwnedVersionParent(dirname(root), true);
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    assertOwnedVersionParent(dirname(root));
  }

  acquire(request: unknown): void {
    try { mkdirSync(this.root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(UPGRADE_ALREADY_OWNED); throw error; }
    syncDirectory(dirname(this.root));
    this.record = { schema: 1, ownerId: this.ownerId, request, phase: 'checking' };
    atomicRecord(join(this.root, 'owner.json'), this.record);
  }

  private assertOwned(): void {
    assertOwnedVersionParent(this.root);
    if (!isDeepStrictEqual(readRecord(join(this.root, 'owner.json')), this.record)) throw new Error(UNVERIFIED);
  }

  phase(phase: string): void {
    this.assertOwned();
    this.record = { ...(this.record as object), phase };
    atomicRecord(join(this.root, 'owner.json'), this.record);
  }

  release(): void {
    this.assertOwned();
    unlinkSync(join(this.root, 'owner.json'));
    rmdirSync(this.root);
    syncDirectory(dirname(this.root));
  }
}

/**
 * The phase a retained guard directory says its upgrade stopped in, or null
 * when it holds no readable record. Read through the same checks acquisition
 * uses, so a link left in place of the record is a refusal and not an answer.
 */
export function retainedUpgradePhase(guardRoot: string): string | null {
  assertOwnedVersionParent(guardRoot);
  const record = readRecord(join(guardRoot, 'owner.json'));
  if (!record || typeof record !== 'object') return null;
  const phase = (record as { phase?: unknown }).phase;
  return typeof phase === 'string' ? phase : null;
}
