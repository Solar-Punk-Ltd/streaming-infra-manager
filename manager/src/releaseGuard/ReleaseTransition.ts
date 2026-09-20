import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, ReleaseGuardStore } from './ReleaseGuardStore.js';
import type {
  PendingReleaseReceipt,
  ReleaseArtifact,
  ReleaseImage,
  ReleaseSlot,
  StackReleaseOperation,
  StackReleaseTarget,
} from './ReleaseGuardTypes.js';

const MAX_MANIFEST_BYTES = 4 * 1024;
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface ReleaseImageSet {
  schemaVersion: 1;
  images: ReleaseImage[];
}

export interface ReleaseBuildPlan {
  candidateRoot: string;
  treeDigest: string;
  slot: ReleaseSlot;
}

export interface ReleaseTransitionPlan extends ReleaseBuildPlan {
  images: ReleaseImage[];
  activeArtifactPath: string | null;
}

export interface ReleaseAdapter {
  preflight(plan: ReleaseBuildPlan): Promise<unknown>;
  build(plan: ReleaseBuildPlan): Promise<ReleaseImageSet>;
  validate?(plan: ReleaseTransitionPlan): Promise<ReleaseImageSet>;
  transition(plan: ReleaseTransitionPlan): Promise<void>;
  verify(plan: ReleaseTransitionPlan): Promise<ReleaseImageSet>;
}

/** Preflights and binds one exact candidate before its adapter may move a service. */
export async function runReleaseTransition(input: {
  store: ReleaseGuardStore;
  candidateRoot: string;
  slot: ReleaseSlot;
  operation?: Extract<StackReleaseOperation, { kind: 'update' }>;
  adapter: ReleaseAdapter;
}): Promise<PendingReleaseReceipt> {
  return input.store.withTransition(async (lease) => {
    await lease.assertMayBuild(input.slot);
    const operation = input.operation
      ? { ...input.operation, mutatingServices: validateMutatingServices(input.operation.mutatingServices) }
      : undefined;
    const target = operation
      ? await requireUploaderOperation(input.store, input.slot, operation)
      : null;
    const candidateRoot = await requireCandidateRoot(input.candidateRoot);
    await requireLifecycleCapability(candidateRoot, input.slot.role);
    const treeDigest = await digestTree(candidateRoot);
    const prepared = { candidateRoot, treeDigest, slot: input.slot };
    const preflight = await input.adapter.preflight(prepared);
    const transitionIdentity = operation
      ? { preflight: preflight ?? null, operation }
      : preflight ?? null;
    const transitionDigest = createHash('sha256').update(canonicalJson(transitionIdentity)).digest('hex');
    const built = validateImageSet(await input.adapter.build(prepared));
    if (target) validateBuiltTarget(built, target);
    const digestAfterBuild = await digestTree(candidateRoot);
    if (digestAfterBuild !== treeDigest) throw new Error('candidate tree changed during the isolated image build');
    const artifact: ReleaseArtifact = { treeDigest, images: built.images };
    const validationPlan: ReleaseTransitionPlan = {
      ...prepared,
      images: built.images,
      activeArtifactPath: null,
    };
    if (operation) {
      if (!input.adapter.validate) throw new Error('release adapter does not support guarded subset validation');
      const running = validateImageSet(await input.adapter.validate(validationPlan));
      validateUntouchedServices(built, running, operation);
    }
    const pending = await lease.prepare({ slot: input.slot, artifact, transitionDigest });
    const activeArtifactPath = input.slot.role === 'admin'
      ? await lease.writeActiveArtifact(pending.body)
      : null;
    const plan: ReleaseTransitionPlan = {
      ...prepared,
      images: built.images,
      activeArtifactPath,
    };
    await input.adapter.transition(plan);
    const running = validateImageSet(await input.adapter.verify(plan));
    if (JSON.stringify(running.images) !== JSON.stringify(built.images)) {
      throw new Error('running image ids do not match the guarded candidate build');
    }
    if (await digestTree(candidateRoot) !== treeDigest) {
      throw new Error('candidate tree changed during the guarded transition');
    }
    await lease.markVerified(pending.body);
    return pending;
  });
}

/** Starts a protected pre-enrollment subset under the guard lease without creating a receipt. */
export async function runStackPreparation(input: {
  store: ReleaseGuardStore;
  candidateRoot: string;
  slot: ReleaseSlot;
  mutatingServices: string[];
  adapter: ReleaseAdapter;
}): Promise<void> {
  await input.store.withTransition(async (lease) => {
    await lease.assertMayPrepareStack();
    const operation: StackReleaseOperation = {
      kind: 'prepare',
      mutatingServices: validateMutatingServices(input.mutatingServices),
    };
    const target = await requireUploaderOperation(input.store, input.slot, operation);
    if (operation.mutatingServices.includes('stream-uploader')) {
      throw new Error('guarded stack preparation cannot start stream-uploader');
    }
    const candidateRoot = await requireCandidateRoot(input.candidateRoot);
    await requireLifecycleCapability(candidateRoot, 'uploader');
    const treeDigest = await digestTree(candidateRoot);
    const prepared = { candidateRoot, treeDigest, slot: input.slot };
    const preflight = await input.adapter.preflight(prepared);
    const transitionDigest = createHash('sha256').update(canonicalJson({
      preflight: preflight ?? null,
      operation,
    })).digest('hex');
    const built = validateImageSet(await input.adapter.build(prepared));
    validatePreparationImages(built, operation);
    if (await digestTree(candidateRoot) !== treeDigest) {
      throw new Error('candidate tree changed during the isolated image build');
    }
    const artifact: ReleaseArtifact = { treeDigest, images: built.images };
    const journal = await lease.prepareStackOperation({
      slot: input.slot,
      target,
      operation,
      artifact,
      transitionDigest,
    });
    const plan: ReleaseTransitionPlan = {
      ...prepared,
      images: built.images,
      activeArtifactPath: null,
    };
    await input.adapter.transition(plan);
    const running = validateImageSet(await input.adapter.verify(plan));
    if (JSON.stringify(running.images) !== JSON.stringify(built.images)) {
      throw new Error('running image ids do not match the guarded preparation build');
    }
    if (await digestTree(candidateRoot) !== treeDigest) {
      throw new Error('candidate tree changed during the guarded preparation');
    }
    await lease.completeStackOperation(journal);
  });
}

async function requireUploaderOperation(
  store: ReleaseGuardStore,
  slot: ReleaseSlot,
  operation: StackReleaseOperation,
): Promise<StackReleaseTarget> {
  if (slot.role !== 'uploader') throw new Error('stack subset operations require an uploader slot');
  const target = await store.deploymentTarget('uploader');
  const services = validateMutatingServices(operation.mutatingServices);
  if (services.some((service) => !target.services.includes(service))) {
    throw new Error('stack subset operation contains a service outside the installed target');
  }
  if (operation.kind === 'update' && !services.includes('stream-uploader')) {
    throw new Error('guarded stack update must include stream-uploader');
  }
  return target;
}

function validateMutatingServices(raw: readonly string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    throw new Error('stack subset services are invalid');
  }
  const services = [...raw].sort();
  if (
    new Set(services).size !== services.length ||
    services.some((service) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(service))
  ) {
    throw new Error('stack subset services are invalid');
  }
  return services;
}

function validatePreparationImages(
  built: ReleaseImageSet,
  operation: StackReleaseOperation,
): void {
  if (built.images.map((image) => image.service).join(',') !== operation.mutatingServices.join(',')) {
    throw new Error('preparation build does not match the guarded service subset');
  }
}

function validateBuiltTarget(built: ReleaseImageSet, target: StackReleaseTarget): void {
  if (built.images.map((image) => image.service).join(',') !== target.services.join(',')) {
    throw new Error('uploader build does not contain the full installed target');
  }
}

function validateUntouchedServices(
  built: ReleaseImageSet,
  running: ReleaseImageSet,
  operation: StackReleaseOperation,
): void {
  const candidate = new Map(built.images.map((image) => [image.service, image.imageId]));
  const actual = new Map(running.images.map((image) => [image.service, image.imageId]));
  if ([...actual.keys()].some((service) => !candidate.has(service))) {
    throw new Error('running uploader target contains an unexpected service');
  }
  const mutating = new Set(operation.mutatingServices);
  for (const [service, imageId] of candidate) {
    if (mutating.has(service)) continue;
    if (actual.get(service) !== imageId) {
      throw new Error(`untouched service ${service} does not match the guarded candidate`);
    }
  }
}

export async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.scratch') continue;
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        hash.update(`directory\0${name}\0${stat.mode & 0o777}\0`);
        await visit(path);
        continue;
      }
      files += 1;
      if (files > MAX_TREE_FILES) throw new Error('candidate tree has too many files');
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        bytes += Buffer.byteLength(target);
        if (bytes > MAX_TREE_BYTES) throw new Error('candidate tree is oversized');
        hash.update(`symlink\0${name}\0${target}\0`);
        continue;
      }
      if (!stat.isFile()) throw new Error(`candidate tree contains unsupported entry ${name}`);
      bytes += stat.size;
      if (bytes > MAX_TREE_BYTES) throw new Error('candidate tree is oversized');
      hash.update(`file\0${name}\0${stat.mode & 0o777}\0${stat.size}\0`);
      await new Promise<void>((resolveStream, rejectStream) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', rejectStream);
        stream.on('end', resolveStream);
      });
      hash.update('\0');
    }
  }

  await visit(root);
  return hash.digest('hex');
}

/** Returns the canonical digest of one real staged candidate directory. */
export async function digestReleaseCandidate(candidateRoot: string): Promise<string> {
  return digestTree(await requireCandidateRoot(candidateRoot));
}

async function requireCandidateRoot(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('candidate root must be absolute');
  const supplied = await lstat(value);
  if (!supplied.isDirectory() || supplied.isSymbolicLink()) {
    throw new Error('candidate root must be a real directory');
  }
  const root = await realpath(value);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('candidate root must be a real directory');
  return root;
}

async function requireLifecycleCapability(root: string, role: ReleaseSlot['role']): Promise<void> {
  const relativeManifest = role === 'admin'
    ? 'web2-admin/backend/release-capabilities.json'
    : role === 'uploader' || role === 'viewer'
      ? 'deploy/capabilities.json'
      : 'deploy/release-capabilities.json';
  const path = join(root, relativeManifest);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error('candidate does not advertise srsLifecycle version 1');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('candidate does not advertise srsLifecycle version 1');
  }
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ['schemaVersion', 'capabilities']) ||
      raw.schemaVersion !== 1 ||
      !isRecord(raw.capabilities) ||
      !hasExactKeys(raw.capabilities, ['srsLifecycle']) ||
      raw.capabilities.srsLifecycle !== 1
    ) {
      throw new Error('unsupported');
    }
  } catch {
    throw new Error('candidate does not advertise srsLifecycle version 1');
  }
}

function validateImageSet(raw: unknown): ReleaseImageSet {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'images']) || raw.schemaVersion !== 1 || !Array.isArray(raw.images)) {
    throw new Error('release adapter image result is invalid');
  }
  const artifact = new ReleaseGuardStoreArtifactValidator({
    treeDigest: '0'.repeat(64),
    images: raw.images,
  }).artifact;
  return { schemaVersion: 1, images: artifact.images };
}

class ReleaseGuardStoreArtifactValidator {
  readonly artifact: ReleaseArtifact;

  constructor(raw: ReleaseArtifact) {
    if (raw.images.length === 0 || raw.images.length > 32) throw new Error('release adapter image result is invalid');
    const images = raw.images.map((image) => {
      if (!isRecord(image) || !hasExactKeys(image, ['service', 'imageId']) || typeof image.service !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(image.service) || typeof image.imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(image.imageId)) {
        throw new Error('release adapter image result is invalid');
      }
      return { service: image.service, imageId: image.imageId };
    }).sort((a, b) => a.service < b.service ? -1 : a.service > b.service ? 1 : 0);
    if (new Set(images.map((image) => image.service)).size !== images.length) {
      throw new Error('release adapter image result has duplicate services');
    }
    this.artifact = { treeDigest: raw.treeDigest, images };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
}
