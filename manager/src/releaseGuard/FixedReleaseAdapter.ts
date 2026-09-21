import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJson } from './ReleaseGuardStore.js';
import type {
  ReleaseAdapter,
  ReleaseBuildPlan,
  ReleaseImageSet,
  ReleaseTransitionPlan,
} from './ReleaseTransition.js';
import type {
  AdminReleaseRuntime,
  ComposeReleaseTarget,
  FixtureNetworkBinding,
  GuardInstallationBinding,
  ManagerReleaseTarget,
  ReleaseRole,
  ResolvedFixtureNetworkBinding,
  StackReleaseTarget,
  StackReleaseOperation,
} from './ReleaseGuardTypes.js';

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PREFLIGHT_BYTES = 4 * 1024;
const DEFAULT_PHASE_TIMEOUT_MS = 20 * 60_000;
const TERMINATION_GRACE_MS = 250;

export interface FixedAdapterArguments {
  target?: ComposeReleaseTarget | ManagerReleaseTarget | StackReleaseTarget;
  fixtureNetwork?: FixtureNetworkBinding;
  operation?: StackReleaseOperation;
  runtime?: AdminReleaseRuntime;
  guardInstallation?: GuardInstallationBinding;
}

interface ResolvedAdapterContext {
  fixtureNetwork?: ResolvedFixtureNetworkBinding;
  fixtureVolumeNames?: string[];
  runtime?: AdminReleaseRuntime;
  guardInstallation?: GuardInstallationBinding;
}

/** Runs only the fixed adapter belonging to the selected component role. */
export class FixedReleaseAdapter implements ReleaseAdapter {
  private resolvedContext: ResolvedAdapterContext | undefined;

  constructor(
    private readonly role: ReleaseRole,
    private readonly workRoot: string,
    private readonly args: FixedAdapterArguments = {},
    private readonly timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  ) {
    if (!isAbsolute(workRoot)) throw new Error('release adapter work root must be absolute');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('release adapter timeout is invalid');
  }

  async preflight(plan: ReleaseBuildPlan): Promise<unknown> {
    const output = join(this.workRoot, 'preflight.json');
    await rm(output, { force: true });
    await this.runPhase('preflight', plan, output);
    const raw = await readBoundedJson(output, MAX_PREFLIGHT_BYTES, 'preflight');
    this.resolvedContext = validateRuntimePreflight(
      this.role,
      plan,
      raw,
      this.args.fixtureNetwork,
      this.args.target,
      this.args.operation,
      this.args.runtime,
      this.args.guardInstallation,
    );
    return this.resolvedContext ?? null;
  }

  async build(plan: ReleaseBuildPlan): Promise<ReleaseImageSet> {
    return this.runResultPhase('build', plan);
  }

  async validate(plan: ReleaseTransitionPlan): Promise<ReleaseImageSet> {
    return this.runResultPhase('validate', plan);
  }

  async transition(plan: ReleaseTransitionPlan): Promise<void> {
    await this.runPhase('transition', plan);
  }

  async verify(plan: ReleaseTransitionPlan): Promise<ReleaseImageSet> {
    return this.runResultPhase('verify', plan);
  }

  private async runResultPhase(
    phase: 'build' | 'validate' | 'verify',
    plan: ReleaseBuildPlan | ReleaseTransitionPlan,
  ): Promise<ReleaseImageSet> {
    const output = join(this.workRoot, `${phase}.json`);
    await rm(output, { force: true });
    await this.runPhase(phase, plan, output);
    return await readBoundedJson(output, MAX_RESULT_BYTES, phase) as ReleaseImageSet;
  }

  private async runPhase(
    phase: 'preflight' | 'build' | 'validate' | 'transition' | 'verify',
    plan: ReleaseBuildPlan | ReleaseTransitionPlan,
    output?: string,
  ): Promise<void> {
    const candidateRoot = resolve(plan.candidateRoot);
    const workRoot = resolve(this.workRoot);
    if (relative(candidateRoot, workRoot) === '' || !relative(candidateRoot, workRoot).startsWith('..')) {
      throw new Error('release adapter work root must be outside the candidate tree');
    }
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const adapter = join(candidateRoot, adapterRelativePath(this.role));
    const adapterStat = await lstat(adapter).catch(() => null);
    if (!adapterStat?.isFile() || adapterStat.isSymbolicLink()) {
      throw new Error(`candidate ${this.role} release adapter is missing`);
    }
    const planPath = join(workRoot, `${phase}-plan.json`);
    await rm(planPath, { force: true });
    const planBody = canonicalJson({
      schemaVersion: 1,
      phase,
      temporaryProject: `release-${plan.treeDigest.slice(0, 20)}`,
      candidateRoot,
      treeDigest: plan.treeDigest,
      slot: plan.slot,
      images: 'images' in plan ? plan.images : [],
      activeArtifactPath: 'activeArtifactPath' in plan ? plan.activeArtifactPath : null,
      arguments: this.resolvedContext
        ? { ...this.args, ...this.resolvedContext }
        : this.args,
    });
    const planHandle = await open(planPath, 'wx', 0o600);
    try {
      await planHandle.writeFile(planBody, 'utf8');
      await planHandle.sync();
    } finally {
      await planHandle.close();
    }
    const argv = [adapter, phase, '--plan', planPath];
    if (output) argv.push('--output', output);
    await runBounded(argv, candidateRoot, this.timeoutMs, phase, this.role);
  }
}

async function readBoundedJson(path: string, maximumBytes: number, phase: string): Promise<unknown> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`release adapter ${phase} result is invalid`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`release adapter ${phase} result is invalid`);
  }
}

function validateRuntimePreflight(
  role: ReleaseRole,
  plan: ReleaseBuildPlan,
  raw: unknown,
  fixtureNetwork: FixtureNetworkBinding | undefined,
  target: FixedAdapterArguments['target'],
  operation: StackReleaseOperation | undefined,
  runtime: AdminReleaseRuntime | undefined,
  guardInstallation: GuardInstallationBinding | undefined,
): ResolvedAdapterContext | undefined {
  const fixtureNetworkId = isRecord(raw) ? raw.fixtureNetworkId : undefined;
  const expectsFixtureVolumes = role === 'uploader' && fixtureNetwork !== undefined;
  const expectedKeys = [
    ...(fixtureNetwork ? ['fixtureNetworkId', ...(expectsFixtureVolumes ? ['fixtureVolumeNames'] : [])] : []),
    ...(runtime ? ['runtime'] : []),
    ...(guardInstallation ? ['guardInstallation'] : []),
  ];
  if (role !== 'uploader') {
    if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', ...expectedKeys]) || raw.schemaVersion !== 1) {
      throw new Error('release adapter preflight result is invalid');
    }
  } else if (operation?.kind === 'prepare') {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ['schemaVersion', 'preparationReady', ...expectedKeys]) ||
      raw.schemaVersion !== 1 ||
      raw.preparationReady !== true
    ) {
      throw new Error('release adapter preparation preflight result is invalid');
    }
  } else {
    const invalid: string[] = [];
    if (!isRecord(raw) || raw.lifecycleVersion !== 1) invalid.push('SRS_LIFECYCLE_VERSION');
    if (!isRecord(raw) || raw.uploaderId !== plan.slot.id) invalid.push('SRS_UPLOADER_ID');
    if (!isRecord(raw) || raw.adminApiConfigured !== true) invalid.push('ADMIN_API_URL');
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ['schemaVersion', 'lifecycleVersion', 'uploaderId', 'adminApiConfigured', ...expectedKeys]) ||
      raw.schemaVersion !== 1
    ) {
      if (invalid.length === 0) throw new Error('release adapter preflight result is invalid');
    }
    if (invalid.length > 0) {
      throw new Error(`effective uploader configuration is incompatible: ${invalid.join(', ')}`);
    }
  }
  if (runtime) {
    if (
      role !== 'admin' ||
      !isRecord(raw) ||
      !isRecord(raw.runtime) ||
      !hasExactKeys(raw.runtime, ['managedLifecycleVersion', 'uploaderId']) ||
      raw.runtime.managedLifecycleVersion !== runtime.managedLifecycleVersion ||
      raw.runtime.uploaderId !== runtime.uploaderId
    ) {
      throw new Error('release adapter admin runtime assignment is invalid');
    }
  }
  if (guardInstallation) {
    if (
      role !== 'manager' ||
      !isRecord(raw) ||
      !isRecord(raw.guardInstallation) ||
      !hasExactKeys(raw.guardInstallation, ['codeRoot', 'stateRoot']) ||
      raw.guardInstallation.codeRoot !== guardInstallation.codeRoot ||
      raw.guardInstallation.stateRoot !== guardInstallation.stateRoot
    ) {
      throw new Error('release adapter installed guard binding is invalid');
    }
  }
  if (!fixtureNetwork && !runtime && !guardInstallation) return undefined;
  const resolved: ResolvedAdapterContext = {};
  if (runtime) resolved.runtime = runtime;
  if (guardInstallation) resolved.guardInstallation = guardInstallation;
  if (!fixtureNetwork) return resolved;
  if (typeof fixtureNetworkId !== 'string' || !/^[0-9a-f]{64}$/.test(fixtureNetworkId)) {
    throw new Error('release adapter fixture network result is invalid');
  }
  resolved.fixtureNetwork = { ...fixtureNetwork, networkId: fixtureNetworkId };
  if (expectsFixtureVolumes) {
    if (!target || !('profile' in target)) throw new Error('release adapter fixture volume result is invalid');
    const expected = [`${target.profile}_srs-media`, `${target.profile}_uploader-state`].sort();
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.fixtureVolumeNames) ||
      raw.fixtureVolumeNames.some((name) => typeof name !== 'string') ||
      (raw.fixtureVolumeNames as string[]).length !== expected.length ||
      !(raw.fixtureVolumeNames as string[]).every((name, index) => name === expected[index])
    ) {
      throw new Error('release adapter fixture volume result is invalid');
    }
    resolved.fixtureVolumeNames = expected;
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

export function adapterRelativePath(role: ReleaseRole): string {
  if (role === 'manager') return 'deploy/release-adapters/manager.sh';
  if (role === 'admin') return 'web2-admin/backend/release-adapter.sh';
  if (role === 'viewer') return 'deploy/scripts/viewer-release-adapter.sh';
  return 'deploy/scripts/release-adapter.sh';
}

async function runBounded(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  phase: 'preflight' | 'build' | 'validate' | 'transition' | 'verify',
  role: ReleaseRole,
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn('/bin/bash', argv, {
      cwd,
      env: adapterEnvironment(role),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, stdoutBytes + chunk.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length);
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already ended.
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), TERMINATION_GRACE_MS);
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      rejectRun(new Error('release adapter could not start'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      const counts = `stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes`;
      if (timedOut) {
        rejectRun(new Error(`release adapter ${phase} timed out (${counts})`));
        return;
      }
      if (code === 0 && signal === null) resolveRun();
      else if (signal) rejectRun(new Error(`release adapter ${phase} was terminated by ${signal} (${counts})`));
      else rejectRun(new Error(`release adapter ${phase} failed with exit ${code ?? 'unknown'} (${counts})`));
    });
  });
}

function adapterEnvironment(role: ReleaseRole): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
  if (role === 'admin') {
    names.push(
      'POSTGRES_PASSWORD',
      'BEE_URL',
      'POSTAGE_BATCH_ID',
      'FEED_PRIVATE_KEY',
      'INTERNAL_API_TOKEN',
      'INGEST_SRT_PASSPHRASE',
      'INGEST_MANAGED_LIFECYCLE_VERSION',
      'INGEST_MANAGED_UPLOADER_ID',
    );
  } else if (role === 'manager') {
    names.push(
      'POSTGRES_PASSWORD',
      'SRS_LIFECYCLE_VERSION',
      'SRS_MANAGED_UPLOADER_PROFILE',
      'ADMIN_API_URL',
      'ADMIN_API_TOKEN',
    );
  } else if (role === 'uploader') {
    names.push('ADMIN_API_URL', 'ADMIN_API_TOKEN', 'API_AUTH_TOKEN');
  }
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}
