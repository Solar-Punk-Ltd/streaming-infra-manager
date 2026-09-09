import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { BundledInputIdentity } from './bundledSourceCapture.js';
import { CONFIG_REVISION_FILE } from './hostConfigCapture.js';
import { isHostInputPath, ownedHostInputPaths } from './hostInputPaths.js';
import { byPath, inventoryOwnedTree, sha256, type OwnedTreeEntry } from './ownedTreeInventory.js';
import { assertRelativeTreePath, assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';

export const BUNDLED_PACKAGE_MANIFEST = '.shipment-manifest.json';
const MANIFEST_MODE = 0o600;
const verifiedPackage = Symbol('verified bundled package');

export interface BundledShipmentIdentity { shipmentId: string; commit: string; digest: string }
export interface BundledPackageCapture { shipmentId: string; commit: string; inputs: BundledInputIdentity }
export interface BundledPackageManifest extends BundledPackageCapture {
  format: 1;
  rootMode: number;
  entries: OwnedTreeEntry[];
  digest: string;
}
export interface VerifiedBundledPackage {
  readonly [verifiedPackage]: true;
  root: string;
  identity: BundledShipmentIdentity;
  manifest: BundledPackageManifest;
}
export interface SealBundledPackageOptions {
  /** Counts only, so callers can report progress without exposing file bytes or input hashes. */
  onProgress?: (copiedFiles: number) => Promise<void>;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error('Invalid package manifest fields.');
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid package identity digest.');
  return value;
}
const SHIPMENT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Whether a name found on disk is one of these identities, for a caller that has to decide rather than refuse. */
export function isBundledShipmentId(value: string): boolean {
  return SHIPMENT_ID.test(value);
}
export function validateBundledShipmentId(value: unknown): string {
  if (typeof value !== 'string' || !isBundledShipmentId(value)) throw new Error('Invalid shipment identity.');
  return value;
}
function commitId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new Error('Invalid package commit identity.');
  return value;
}
function mode(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o7777) throw new Error('Invalid package file mode.');
  return value;
}
function inputIdentity(value: unknown): BundledInputIdentity {
  const input = record(value, ['generation', 'hashes']);
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1 || !input.hashes ||
      typeof input.hashes !== 'object' || Array.isArray(input.hashes)) throw new Error('Invalid package input revision.');
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(input.hashes).sort()) {
    if (!isHostInputPath(path)) throw new Error('Invalid package input path.');
    hashes[path] = hash((input.hashes as Record<string, unknown>)[path]);
  }
  return { generation: input.generation as number, hashes };
}
export function validateBundledShipmentIdentity(value: unknown): BundledShipmentIdentity {
  const item = record(value, ['shipmentId', 'commit', 'digest']);
  return { shipmentId: validateBundledShipmentId(item.shipmentId), commit: commitId(item.commit), digest: hash(item.digest) };
}
function entry(value: unknown): OwnedTreeEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid package inventory entry.');
  const type = (value as Record<string, unknown>).type;
  const extra = type === 'file' ? ['sha256'] : type === 'symlink' ? ['target'] : type === 'directory' ? [] : null;
  if (!extra) throw new Error('Invalid package inventory type.');
  const item = record(value, ['path', 'mode', 'type', ...extra]);
  if (typeof item.path !== 'string' || item.path === BUNDLED_PACKAGE_MANIFEST) throw new Error('Invalid package inventory path.');
  assertRelativeTreePath(item.path);
  const base = { path: item.path, mode: mode(item.mode) };
  if (type === 'file') return { ...base, type, sha256: hash(item.sha256) };
  if (type === 'symlink') {
    if (typeof item.target !== 'string') throw new Error('Invalid package link target.');
    return { ...base, type, target: item.target };
  }
  return { ...base, type: 'directory' };
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Package manifest is not valid JSON.'); }
}

export async function assertCopiedBundledInputs(root: string, expected: BundledInputIdentity): Promise<void> {
  const raw = record(parseJson(await readOwnedFile(root, CONFIG_REVISION_FILE)), ['generation', 'files']);
  const revision = inputIdentity({ generation: raw.generation, hashes: raw.files });
  if (!isDeepStrictEqual(revision, expected)) throw new Error('Package input identity differs from its committed revision.');
  const hashes: Record<string, string> = {};
  for (const path of (await ownedHostInputPaths(root)).sort()) hashes[path] = sha256(await readOwnedFile(root, path));
  if (!isDeepStrictEqual(hashes, expected.hashes)) throw new Error('Package input files differ from the complete captured input set.');
}

/** The digest covers this exact canonical payload. Only the digest field and the manifest's inventory entry are excluded. */
function manifestPayload(raw: unknown): Omit<BundledPackageManifest, 'digest'> {
  const item = record(raw, ['format', 'shipmentId', 'commit', 'inputs', 'rootMode', 'entries', 'digest']);
  if (item.format !== 1 || !Array.isArray(item.entries)) throw new Error('Invalid package manifest format.');
  const entries = item.entries.map(entry).sort(byPath);
  if (new Set(entries.map(item => item.path)).size !== entries.length) throw new Error('Duplicate package inventory path.');
  return { format: 1, shipmentId: validateBundledShipmentId(item.shipmentId), commit: commitId(item.commit), inputs: inputIdentity(item.inputs), rootMode: mode(item.rootMode), entries };
}

/** Validates the envelope only. Trust in its files still requires a complete inventory check. */
export function parseBundledPackageManifest(bytes: Buffer): BundledPackageManifest {
  const raw = parseJson(bytes);
  const payload = manifestPayload(raw);
  const digest = hash((raw as Record<string, unknown>).digest);
  const manifest = { ...payload, digest };
  if (digest !== sha256(JSON.stringify(payload)) || !isDeepStrictEqual(raw, manifest)) throw new Error('Package manifest digest or inventory is invalid.');
  return manifest;
}

/** Reads the full owned tree before returning the verification token used by shipment activation. */
export async function verifyBundledPackage(root: string, expectedIdentity: BundledShipmentIdentity): Promise<VerifiedBundledPackage> {
  const expected = validateBundledShipmentIdentity(expectedIdentity);
  const bytes = await readOwnedFile(root, BUNDLED_PACKAGE_MANIFEST);
  if (((await lstat(join(root, BUNDLED_PACKAGE_MANIFEST))).mode & 0o7777) !== MANIFEST_MODE) throw new Error('Package manifest mode changed.');
  const manifest = parseBundledPackageManifest(bytes);
  if (!isDeepStrictEqual(expected, { shipmentId: manifest.shipmentId, commit: manifest.commit, digest: manifest.digest })) throw new Error('Package identity does not match the expected identity.');
  const actual = await inventoryOwnedTree(root, BUNDLED_PACKAGE_MANIFEST);
  if (actual.rootMode !== manifest.rootMode || !isDeepStrictEqual(actual.entries, manifest.entries)) throw new Error('Package inventory differs from the sealed manifest.');
  await assertCopiedBundledInputs(root, manifest.inputs);
  if (!(await readOwnedFile(root, BUNDLED_PACKAGE_MANIFEST)).equals(bytes)) throw new Error('Package manifest changed during verification.');
  return { [verifiedPackage]: true, root, identity: expected, manifest };
}

export async function sealBundledPackage(
  source: string,
  destination: string,
  capture: BundledPackageCapture,
  options: SealBundledPackageOptions = {},
): Promise<VerifiedBundledPackage> {
  const selected = { shipmentId: validateBundledShipmentId(capture.shipmentId), commit: commitId(capture.commit), inputs: inputIdentity(capture.inputs) };
  await assertSeparateOwnedTrees(source, destination);
  const baseline = await inventoryOwnedTree(source);
  if (baseline.entries.some(item => item.path === BUNDLED_PACKAGE_MANIFEST)) throw new Error('Source already contains a package manifest.');
  await assertCopiedBundledInputs(source, selected.inputs);
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const item of baseline.entries.filter(item => item.type === 'directory')) await mkdir(join(destination, item.path), { mode: 0o700 });
    let copiedFiles = 0;
    for (const item of baseline.entries) {
      if (item.type === 'file') {
        const bytes = await readOwnedFile(source, item.path);
        if (sha256(bytes) !== item.sha256) throw new Error('Package source changed while sealing.');
        await writeFile(join(destination, item.path), bytes, { flag: 'wx', mode: item.mode });
        await chmod(join(destination, item.path), item.mode);
        await options.onProgress?.(++copiedFiles);
      } else if (item.type === 'symlink') {
        // No mode is set on a link, because Linux has no call that would and records 0777 either way.
        await symlink(item.target, join(destination, item.path));
      }
    }
    if (!isDeepStrictEqual(await inventoryOwnedTree(source), baseline)) throw new Error('Package source changed while sealing.');
    for (const item of baseline.entries.filter(item => item.type === 'directory').reverse()) await chmod(join(destination, item.path), item.mode);
    const payload = { format: 1 as const, ...selected, rootMode: baseline.rootMode, entries: baseline.entries };
    const digest = sha256(JSON.stringify(payload));
    await writeFile(join(destination, BUNDLED_PACKAGE_MANIFEST), JSON.stringify({ ...payload, digest }) + '\n', { flag: 'wx', mode: MANIFEST_MODE });
    await chmod(destination, baseline.rootMode);
    return await verifyBundledPackage(destination, { shipmentId: selected.shipmentId, commit: selected.commit, digest });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
