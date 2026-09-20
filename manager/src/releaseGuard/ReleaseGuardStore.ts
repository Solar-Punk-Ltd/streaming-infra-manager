import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RELEASE_GUARD_MINIMUM,
  RELEASE_GUARD_SCHEMA_VERSION,
  type PendingReleaseReceipt,
  type ActiveArtifactMetadata,
  type ComposeReleaseTarget,
  type ManagerReleaseTarget,
  type ReleaseArtifact,
  type ReleaseGuardReceipt,
  type ReleaseGuardAttempt,
  type ReleaseGuardState,
  type ReleaseImage,
  type ReleaseSlot,
  type StoredReleaseSlot,
  type StackReleaseTarget,
} from './ReleaseGuardTypes.js';

const MARKER = 'installed.json';
const STATE = 'state.json';
const ACTIVATION = 'managed-required.json';
const TARGETS = 'targets.json';
const PENDING = 'pending';
const TRANSITIONS = 'transitions';
const LOCK = 'state.lock';
const LEGACY_OWNER = 'legacy-owner.json';
const LEGACY_RELEASE_CLAIM = 'legacy-release.claim';
const MAX_STATE_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UPLOADER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface ReleaseGuardDeploymentTargets {
  manager?: ManagerReleaseTarget;
  admin?: ComposeReleaseTarget;
  uploader?: StackReleaseTarget;
  viewer?: StackReleaseTarget;
}

class MissingGuardFileError extends Error {}

/** Creates a guard installation once. Existing or partial installations refuse. */
export async function installReleaseGuard(
  root: string,
  installationId: string = randomUUID(),
  targets: ReleaseGuardDeploymentTargets = {},
): Promise<void> {
  requireUuid(installationId, 'installation id');
  const targetBody = canonicalJson(validateDeploymentTargets({
    schemaVersion: 1,
    installationId,
    targets,
  }));
  const existingRoot = await lstat(root).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (existingRoot && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
    throw new Error('release guard state root must be a real directory');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const marker = join(root, MARKER);
  const statePath = join(root, STATE);
  if (
    await exists(marker) ||
    await exists(statePath) ||
    await exists(join(root, TARGETS)) ||
    await exists(join(root, PENDING)) ||
    await exists(join(root, TRANSITIONS)) ||
    await exists(join(root, ACTIVATION)) ||
    await exists(join(root, LOCK))
  ) {
    throw new Error('release guard is already installed or partially initialized');
  }
  await mkdir(join(root, PENDING), { mode: 0o700 });
  await mkdir(join(root, TRANSITIONS), { mode: 0o700 });
  const state: ReleaseGuardState = {
    schemaVersion: RELEASE_GUARD_SCHEMA_VERSION,
    installationId,
    generation: 0,
    slots: {},
    attempt: null,
  };
  await atomicWrite(root, TARGETS, targetBody);
  await atomicWrite(root, STATE, canonicalJson(state));
  await atomicWrite(root, MARKER, canonicalJson({
    schemaVersion: 1,
    installationId,
    targetDigest: sha256(targetBody),
  }));
}

/** Durable monotonic release requirements owned by the installed wrapper. */
export class ReleaseGuardStore {
  constructor(private readonly root: string) {}

  async read(): Promise<ReleaseGuardState> {
    await requireRegularFile(join(this.root, MARKER), 'installed guard marker is missing');
    const marker = await readBounded(join(this.root, MARKER));
    const raw = await readBounded(join(this.root, STATE)).catch((error: unknown) => {
      if (error instanceof MissingGuardFileError) throw new Error('installed guard state is missing');
      throw new Error('installed guard state is unreadable');
    });
    let state: ReleaseGuardState;
    try {
      state = parseState(JSON.parse(raw));
      const installed = parseInstallationMarker(JSON.parse(marker));
      if (installed.installationId !== state.installationId) throw new Error('installation mismatch');
      const targetBody = await readBounded(join(this.root, TARGETS));
      const targets = validateDeploymentTargets(JSON.parse(targetBody));
      if (targets.installationId !== state.installationId || sha256(targetBody) !== installed.targetDigest) {
        throw new Error('target mismatch');
      }
    } catch {
      throw new Error('installed guard state is invalid');
    }
    await validateActivationSentinel(this.root, state);
    return state;
  }

  async releaseMode(): Promise<'legacy' | 'managed'> {
    return hasActivationEvidence(await this.read()) ? 'managed' : 'legacy';
  }

  async deploymentTarget(role: 'manager'): Promise<ManagerReleaseTarget>;
  async deploymentTarget(role: 'admin'): Promise<ComposeReleaseTarget>;
  async deploymentTarget(role: 'uploader' | 'viewer'): Promise<StackReleaseTarget>;
  async deploymentTarget(role: 'manager' | 'admin' | 'uploader' | 'viewer'): Promise<ManagerReleaseTarget | ComposeReleaseTarget | StackReleaseTarget>;
  async deploymentTarget(role: 'manager' | 'admin' | 'uploader' | 'viewer'): Promise<ManagerReleaseTarget | ComposeReleaseTarget | StackReleaseTarget> {
    const state = await this.read();
    const targets = validateDeploymentTargets(JSON.parse(await readBounded(join(this.root, TARGETS))));
    if (targets.installationId !== state.installationId) throw new Error('release guard deployment targets are invalid');
    const target = targets.targets[role];
    if (!target) throw new Error(`release guard ${role} target is not installed`);
    return target;
  }

  async withTransition<T>(action: (lease: ReleaseTransitionLease) => Promise<T>): Promise<T> {
    return this.withLock(() => action(new ReleaseTransitionLease(this.root, this)));
  }

  async beginLegacyLease(): Promise<{ mode: 'managed' } | { mode: 'legacy'; ownerToken: string }> {
    await this.acquireLock();
    try {
      if (await this.releaseMode() === 'managed') {
        await this.releaseEmptyLock();
        return { mode: 'managed' };
      }
      const state = await this.read();
      const ownerToken = randomUUID();
      await atomicWrite(join(this.root, LOCK), LEGACY_OWNER, canonicalJson({
        schemaVersion: 1,
        installationId: state.installationId,
        ownerToken,
      }));
      return { mode: 'legacy', ownerToken };
    } catch (error) {
      await this.releaseEmptyLock().catch(() => undefined);
      throw error;
    }
  }

  async finishLegacyLease(ownerToken: string): Promise<void> {
    requireUuid(ownerToken, 'legacy lease owner token');
    const state = await this.read();
    const ownerPath = join(this.root, LOCK, LEGACY_OWNER);
    const claimPath = join(this.root, LOCK, LEGACY_RELEASE_CLAIM);
    let owner: unknown;
    try {
      owner = JSON.parse(await readBounded(ownerPath));
    } catch {
      throw new Error('legacy deployment lease is invalid');
    }
    if (
      !isRecord(owner) ||
      !hasExactKeys(owner, ['schemaVersion', 'installationId', 'ownerToken']) ||
      owner.schemaVersion !== 1 ||
      owner.installationId !== state.installationId ||
      owner.ownerToken !== ownerToken
    ) {
      throw new Error('legacy deployment lease owner token does not match');
    }
    try {
      await link(ownerPath, claimPath);
    } catch {
      throw new Error('legacy deployment lease is already being released or requires operator recovery');
    }
    try {
      const claimedOwner = JSON.parse(await readBounded(claimPath));
      const [ownerStat, claimStat] = await Promise.all([lstat(ownerPath), lstat(claimPath)]);
      if (
        !isRecord(claimedOwner) ||
        !hasExactKeys(claimedOwner, ['schemaVersion', 'installationId', 'ownerToken']) ||
        claimedOwner.schemaVersion !== 1 ||
        claimedOwner.installationId !== state.installationId ||
        claimedOwner.ownerToken !== ownerToken ||
        ownerStat.dev !== claimStat.dev ||
        ownerStat.ino !== claimStat.ino
      ) {
        throw new Error('legacy deployment lease owner token does not match');
      }
    } catch (error) {
      await rm(claimPath).catch(() => undefined);
      throw error;
    }
    await rm(ownerPath);
    await syncDirectory(join(this.root, LOCK));
    await rm(claimPath);
    await syncDirectory(join(this.root, LOCK));
    await this.releaseEmptyLock();
  }

  async pendingReceipt(slot: ReleaseSlot): Promise<string | null> {
    const valid = validateSlot(slot);
    const state = await this.read();
    if (
      state.attempt?.phase !== 'verified' ||
      slotKey(state.attempt.receipt.slot) !== slotKey(valid)
    ) {
      return null;
    }
    try {
      const body = await readBounded(join(this.root, PENDING, pendingFile(valid)));
      if (body !== state.attempt.body) throw new Error('release receipt outbox does not match verified state');
      return body;
    } catch (error) {
      if (error instanceof MissingGuardFileError) return null;
      throw error;
    }
  }

  async acknowledge(exactBody: string): Promise<void> {
    await this.withLock(async () => {
      const receipt = parseReceipt(JSON.parse(exactBody));
      const state = await this.read();
      if (state.attempt?.phase !== 'verified' || state.attempt.body !== exactBody) {
        throw new Error('release receipt acknowledgement does not match verified state');
      }
      const path = join(this.root, PENDING, pendingFile(receipt.slot));
      const pending = await readBounded(path);
      if (pending !== exactBody) throw new Error('release receipt acknowledgement does not match the durable outbox');
      await atomicWrite(this.root, STATE, canonicalJson({ ...state, attempt: null }));
      await rm(path);
      await syncDirectory(join(this.root, PENDING));
    });
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await action();
    } finally {
      await this.releaseEmptyLock();
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      await mkdir(join(this.root, LOCK), { mode: 0o700 });
      await syncDirectory(this.root);
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') {
        throw new Error('another release guard transition is active, or its crash lock requires operator recovery');
      }
      throw error;
    }
  }

  private async releaseEmptyLock(): Promise<void> {
    await rmdir(join(this.root, LOCK));
    await syncDirectory(this.root);
  }
}

/** Operations available only while the host-wide transition lease is held. */
class ReleaseTransitionLease {
  constructor(
    private readonly root: string,
    private readonly store: ReleaseGuardStore,
  ) {}

  async assertMayBuild(input: ReleaseSlot): Promise<void> {
    const slot = validateSlot(input);
    const state = await this.store.read();
    if (
      state.attempt?.phase === 'verified' ||
      (state.attempt?.phase === 'prepared' && slotKey(state.attempt.receipt.slot) !== slotKey(slot))
    ) {
      throw new Error('a release guard transition or receipt is unresolved');
    }
  }

  async prepare(input: {
    slot: ReleaseSlot;
    artifact: ReleaseArtifact;
  }): Promise<PendingReleaseReceipt> {
    const state = await this.store.read();
    const slot = validateSlot(input.slot);
    const artifact = validateArtifact(input.artifact);
    if (state.attempt) {
      if (
        state.attempt.phase === 'prepared' &&
        slotKey(state.attempt.receipt.slot) === slotKey(slot) &&
        canonicalJson(state.attempt.receipt.artifact) === canonicalJson(artifact)
      ) {
        return { receipt: state.attempt.receipt, body: state.attempt.body };
      }
      throw new Error('a release guard transition or receipt is unresolved');
    }
    const generation = state.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('release guard generation is exhausted');
    const core: ReleaseGuardState = {
      ...state,
      generation,
      slots: {
        ...state.slots,
        [slotKey(slot)]: { minimums: RELEASE_GUARD_MINIMUM, artifact },
      },
      attempt: null,
    };
    const receipt: ReleaseGuardReceipt = {
      schemaVersion: RELEASE_GUARD_SCHEMA_VERSION,
      installationId: core.installationId,
      generation,
      stateDigest: sha256(canonicalJson(core)),
      slot,
      minimums: RELEASE_GUARD_MINIMUM,
      artifact,
    };
    const body = canonicalJson(receipt);
    await atomicWrite(this.root, STATE, canonicalJson({
      ...core,
      attempt: { phase: 'prepared', receipt, body },
    }));
    await writeActivationSentinel(this.root, core.installationId);
    return { receipt, body };
  }

  async markVerified(exactBody: string): Promise<void> {
    const state = await this.store.read();
    if (state.attempt?.phase !== 'prepared' || state.attempt.body !== exactBody) {
      throw new Error('verified release does not match the prepared transition');
    }
    await atomicWrite(
      join(this.root, PENDING),
      pendingFile(state.attempt.receipt.slot),
      exactBody,
    );
    await atomicWrite(this.root, STATE, canonicalJson({
      ...state,
      attempt: { ...state.attempt, phase: 'verified' },
    }));
  }

  async writeActiveArtifact(exactBody: string): Promise<string> {
    const state = await this.store.read();
    if (state.attempt?.phase !== 'prepared' || state.attempt.body !== exactBody) {
      throw new Error('active artifact does not match the prepared transition');
    }
    const receipt = state.attempt.receipt;
    if (receipt.slot.role !== 'admin' || receipt.slot.id !== 'default') {
      throw new Error('active artifact metadata is only defined for admin/default');
    }
    const metadata: ActiveArtifactMetadata = {
      schemaVersion: 1,
      installationId: receipt.installationId,
      generation: receipt.generation,
      slot: receipt.slot,
      artifact: receipt.artifact,
    };
    const directory = join(
      this.root,
      TRANSITIONS,
      `${receipt.generation}-${receipt.slot.role}-${receipt.slot.id}`,
    );
    await mkdir(directory, { mode: 0o700 }).catch(async (error: unknown) => {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('active artifact metadata directory is invalid');
    }
    const path = join(directory, 'active-artifact.json');
    const body = canonicalJson(metadata);
    if (await exists(path)) {
      if (await readBounded(path) !== body) throw new Error('active artifact metadata path is already bound differently');
      return path;
    }
    await atomicWrite(directory, 'active-artifact.json', body);
    await chmod(path, 0o444);
    await syncDirectory(directory);
    return path;
  }
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`;
}

export function parseReceipt(raw: unknown): ReleaseGuardReceipt {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'schemaVersion',
    'installationId',
    'generation',
    'stateDigest',
    'slot',
    'minimums',
    'artifact',
  ])) throw new Error('release receipt is invalid');
  if (raw.schemaVersion !== 1) throw new Error('release receipt is invalid');
  requireUuid(raw.installationId, 'release receipt installation id');
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1) throw new Error('release receipt is invalid');
  if (typeof raw.stateDigest !== 'string' || !DIGEST.test(raw.stateDigest)) throw new Error('release receipt is invalid');
  if (!isMinimum(raw.minimums)) throw new Error('release receipt is invalid');
  return {
    schemaVersion: 1,
    installationId: raw.installationId,
    generation: Number(raw.generation),
    stateDigest: raw.stateDigest,
    slot: validateSlot(raw.slot),
    minimums: RELEASE_GUARD_MINIMUM,
    artifact: validateArtifact(raw.artifact),
  };
}

function parseState(raw: unknown): ReleaseGuardState {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'installationId', 'generation', 'slots', 'attempt'])) {
    throw new Error('release guard state is invalid');
  }
  if (raw.schemaVersion !== 1) throw new Error('release guard state is invalid');
  requireUuid(raw.installationId, 'release guard installation id');
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0 || !isRecord(raw.slots)) {
    throw new Error('release guard state is invalid');
  }
  if (Object.keys(raw.slots).length > 256) throw new Error('release guard state is invalid');
  const slots: Record<string, StoredReleaseSlot> = {};
  for (const [key, value] of Object.entries(raw.slots)) {
    if (!isRecord(value) || !hasExactKeys(value, ['minimums', 'artifact']) || !isMinimum(value.minimums)) {
      throw new Error('release guard state is invalid');
    }
    const slot = slotFromKey(key);
    slots[slotKey(slot)] = {
      minimums: RELEASE_GUARD_MINIMUM,
      artifact: validateArtifact(value.artifact),
    };
  }
  let attempt: ReleaseGuardAttempt | null = null;
  if (raw.attempt !== null) {
    if (!isRecord(raw.attempt) || !hasExactKeys(raw.attempt, ['phase', 'receipt', 'body']) ||
        (raw.attempt.phase !== 'prepared' && raw.attempt.phase !== 'verified') || typeof raw.attempt.body !== 'string') {
      throw new Error('release guard state is invalid');
    }
    const receipt = parseReceipt(raw.attempt.receipt);
    const storedSlot = slots[slotKey(receipt.slot)];
    const core: ReleaseGuardState = {
      schemaVersion: 1,
      installationId: raw.installationId,
      generation: Number(raw.generation),
      slots,
      attempt: null,
    };
    if (
      canonicalJson(receipt) !== raw.attempt.body ||
      receipt.installationId !== raw.installationId ||
      receipt.generation !== raw.generation ||
      receipt.stateDigest !== sha256(canonicalJson(core)) ||
      !storedSlot ||
      canonicalJson(receipt.artifact) !== canonicalJson(storedSlot.artifact)
    ) {
      throw new Error('release guard state is invalid');
    }
    const phase = raw.attempt.phase;
    attempt = { phase, receipt, body: raw.attempt.body };
  }
  if ((Number(raw.generation) === 0) !== (Object.keys(slots).length === 0 && attempt === null)) {
    throw new Error('release guard state is invalid');
  }
  return {
    schemaVersion: 1,
    installationId: raw.installationId,
    generation: Number(raw.generation),
    slots,
    attempt,
  };
}

function hasActivationEvidence(state: ReleaseGuardState): boolean {
  return state.generation > 0 || Object.keys(state.slots).length > 0 || state.attempt !== null;
}

async function validateActivationSentinel(root: string, state: ReleaseGuardState): Promise<void> {
  const path = join(root, ACTIVATION);
  let raw: string | null;
  try {
    raw = await readBounded(path);
  } catch (error) {
    if (error instanceof MissingGuardFileError) raw = null;
    else throw new Error('release guard activation sentinel is invalid');
  }
  if (!hasActivationEvidence(state)) {
    if (raw !== null) throw new Error('release guard activation state is partial');
    return;
  }
  if (raw === null) throw new Error('release guard activation sentinel is missing');
  try {
    const sentinel = parseActivationSentinel(JSON.parse(raw));
    if (sentinel.installationId !== state.installationId) throw new Error('installation mismatch');
  } catch {
    throw new Error('release guard activation sentinel is invalid');
  }
}

async function writeActivationSentinel(root: string, installationId: string): Promise<void> {
  const path = join(root, ACTIVATION);
  if (await exists(path)) {
    const state = parseState(JSON.parse(await readBounded(join(root, STATE))));
    await validateActivationSentinel(root, state);
    return;
  }
  await atomicWrite(root, ACTIVATION, canonicalJson({ schemaVersion: 1, installationId }));
}

function validateDeploymentTargets(raw: unknown): {
  schemaVersion: 1;
  installationId: string;
  targets: ReleaseGuardDeploymentTargets;
} {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'installationId', 'targets']) || raw.schemaVersion !== 1) {
    throw new Error('release guard deployment targets are invalid');
  }
  requireUuid(raw.installationId, 'release guard installation id');
  if (!isRecord(raw.targets) || Object.keys(raw.targets).some((key) => !['manager', 'admin', 'uploader', 'viewer'].includes(key))) {
    throw new Error('release guard deployment targets are invalid');
  }
  const targets: ReleaseGuardDeploymentTargets = {};
  for (const role of ['manager', 'admin'] as const) {
    const target = raw.targets[role];
    if (target === undefined) continue;
    const expectedKeys = role === 'manager'
      ? ['mode', 'postgresPort', 'postgresVolumeName', 'projectName', 'webPort']
      : ['postgresVolumeName', 'projectName', 'webPort'];
    if (
      !isRecord(target) ||
      !hasExactKeys(target, expectedKeys) ||
      typeof target.projectName !== 'string' ||
      !DEPLOYMENT_NAME.test(target.projectName) ||
      typeof target.postgresVolumeName !== 'string' ||
      !DEPLOYMENT_NAME.test(target.postgresVolumeName) ||
      !Number.isSafeInteger(target.webPort) ||
      Number(target.webPort) < 1 ||
      Number(target.webPort) > 65_535
    ) {
      throw new Error('release guard deployment targets are invalid');
    }
    const common = {
      projectName: target.projectName,
      postgresVolumeName: target.postgresVolumeName,
      webPort: Number(target.webPort),
    };
    if (role === 'admin') {
      targets.admin = common;
      continue;
    }
    if (
      (target.mode !== 'production' && target.mode !== 'isolated') ||
      !Number.isSafeInteger(target.postgresPort) ||
      Number(target.postgresPort) < 1 ||
      Number(target.postgresPort) > 65_535 ||
      (target.mode === 'isolated' && (
        target.postgresPort === 5_432 ||
        target.webPort === 8_080 ||
        target.postgresPort === target.webPort
      ))
    ) {
      throw new Error('release guard deployment targets are invalid');
    }
    targets.manager = {
      ...common,
      mode: target.mode,
      postgresPort: Number(target.postgresPort),
    };
  }
  for (const role of ['uploader', 'viewer'] as const) {
    const target = raw.targets[role];
    if (target === undefined) continue;
    if (
      !isRecord(target) ||
      !hasExactKeys(target, ['profile', 'portSlot', 'services', 'target']) ||
      typeof target.profile !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.profile) ||
      !Number.isSafeInteger(target.portSlot) ||
      Number(target.portSlot) < 1 ||
      Number(target.portSlot) > 99 ||
      target.target !== 'local' ||
      !Array.isArray(target.services) ||
      target.services.some((service) => typeof service !== 'string')
    ) {
      throw new Error('release guard deployment targets are invalid');
    }
    const services = target.services as string[];
    const sorted = [...services].sort();
    if (new Set(services).size !== services.length || services.some((service, index) => service !== sorted[index])) {
      throw new Error('release guard deployment targets are invalid');
    }
    if (role === 'uploader') {
      const allowed = new Set([
        'bee-gateway',
        'bee-uploader',
        'bee-uploader-1080p',
        'bee-uploader-480p',
        'bee-uploader-720p',
        'client',
        'srs',
        'stream-uploader',
      ]);
      if (
        services.some((service) => !allowed.has(service)) ||
        !services.includes('srs') ||
        !services.includes('stream-uploader')
      ) {
        throw new Error('release guard deployment targets are invalid');
      }
    } else if (
      services.join(',') !== 'client' &&
      services.join(',') !== 'bee-gateway,client'
    ) {
      throw new Error('release guard deployment targets are invalid');
    }
    targets[role] = {
      profile: target.profile,
      portSlot: Number(target.portSlot),
      target: 'local',
      services: [...services],
    };
  }
  return { schemaVersion: 1, installationId: raw.installationId, targets };
}

function parseInstallationMarker(raw: unknown): { schemaVersion: 1; installationId: string; targetDigest: string } {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['schemaVersion', 'installationId', 'targetDigest']) ||
    raw.schemaVersion !== 1 ||
    typeof raw.targetDigest !== 'string' ||
    !DIGEST.test(raw.targetDigest)
  ) {
    throw new Error('release guard marker is invalid');
  }
  requireUuid(raw.installationId, 'release guard installation id');
  return { schemaVersion: 1, installationId: raw.installationId, targetDigest: raw.targetDigest };
}

function parseActivationSentinel(raw: unknown): { schemaVersion: 1; installationId: string } {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'installationId']) || raw.schemaVersion !== 1) {
    throw new Error('release guard activation sentinel is invalid');
  }
  requireUuid(raw.installationId, 'release guard installation id');
  return { schemaVersion: 1, installationId: raw.installationId };
}

function validateSlot(raw: unknown): ReleaseSlot {
  if (!isRecord(raw) || !hasExactKeys(raw, ['role', 'id']) || typeof raw.role !== 'string' || typeof raw.id !== 'string') {
    throw new Error('release slot is invalid');
  }
  if (!['manager', 'admin', 'uploader', 'viewer'].includes(raw.role)) throw new Error('release slot is invalid');
  if (raw.role === 'uploader') {
    if (!UPLOADER_ID.test(raw.id)) throw new Error('uploader slot id is invalid');
  } else if (raw.id !== 'default') {
    throw new Error(`${raw.role} slot id must be default`);
  }
  return { role: raw.role as ReleaseSlot['role'], id: raw.id };
}

function validateArtifact(raw: unknown): ReleaseArtifact {
  if (!isRecord(raw) || !hasExactKeys(raw, ['treeDigest', 'images']) || typeof raw.treeDigest !== 'string' || !DIGEST.test(raw.treeDigest) || !Array.isArray(raw.images) || raw.images.length === 0 || raw.images.length > 32) {
    throw new Error('release artifact is invalid');
  }
  const images = raw.images.map(validateImage).sort((a, b) =>
    a.service < b.service ? -1 : a.service > b.service ? 1 : 0,
  );
  if (new Set(images.map((image) => image.service)).size !== images.length) throw new Error('release artifact has duplicate services');
  return { treeDigest: raw.treeDigest, images };
}

function validateImage(raw: unknown): ReleaseImage {
  if (!isRecord(raw) || !hasExactKeys(raw, ['service', 'imageId']) || typeof raw.service !== 'string' || !SERVICE.test(raw.service) || typeof raw.imageId !== 'string' || !IMAGE_ID.test(raw.imageId)) {
    throw new Error('release image is invalid');
  }
  return { service: raw.service, imageId: raw.imageId };
}

function isMinimum(raw: unknown): raw is { srsLifecycle: 1 } {
  return isRecord(raw) && hasExactKeys(raw, ['srsLifecycle']) && raw.srsLifecycle === 1;
}

function slotKey(slot: ReleaseSlot): string {
  return `${slot.role}/${slot.id}`;
}

function slotFromKey(key: string): ReleaseSlot {
  const slash = key.indexOf('/');
  if (slash < 1) throw new Error('release slot key is invalid');
  return validateSlot({ role: key.slice(0, slash), id: key.slice(slash + 1) });
}

function pendingFile(slot: ReleaseSlot): string {
  return `${slot.role}-${slot.id}.json`;
}

function requireUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
}

async function readBounded(path: string): Promise<string> {
  await requireRegularFile(path, 'file is missing');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_STATE_BYTES) throw new Error('release guard file is oversized');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function requireRegularFile(path: string, missingMessage: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) throw new MissingGuardFileError(missingMessage);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('release guard file is not a regular file');
}

async function atomicWrite(directory: string, name: string, body: string): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const destination = join(directory, name);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(directory);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => isMissing(error) ? false : Promise.reject(error));
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
