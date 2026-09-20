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
  ComposeReleaseTarget,
  FixtureNetworkBinding,
  ManagerReleaseTarget,
  ReleaseRole,
  ResolvedFixtureNetworkBinding,
  StackReleaseTarget,
} from './ReleaseGuardTypes.js';

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PREFLIGHT_BYTES = 4 * 1024;
const DEFAULT_PHASE_TIMEOUT_MS = 20 * 60_000;
const TERMINATION_GRACE_MS = 250;

export interface FixedAdapterArguments {
  target?: ComposeReleaseTarget | ManagerReleaseTarget | StackReleaseTarget;
  fixtureNetwork?: FixtureNetworkBinding;
}

/** Runs only the fixed adapter belonging to the selected component role. */
export class FixedReleaseAdapter implements ReleaseAdapter {
  private resolvedFixtureNetwork: ResolvedFixtureNetworkBinding | undefined;

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
    this.resolvedFixtureNetwork = validateRuntimePreflight(this.role, plan, raw, this.args.fixtureNetwork);
    return this.resolvedFixtureNetwork ? { fixtureNetwork: this.resolvedFixtureNetwork } : null;
  }

  async build(plan: ReleaseBuildPlan): Promise<ReleaseImageSet> {
    return this.runResultPhase('build', plan);
  }

  async transition(plan: ReleaseTransitionPlan): Promise<void> {
    await this.runPhase('transition', plan);
  }

  async verify(plan: ReleaseTransitionPlan): Promise<ReleaseImageSet> {
    return this.runResultPhase('verify', plan);
  }

  private async runResultPhase(
    phase: 'build' | 'verify',
    plan: ReleaseBuildPlan | ReleaseTransitionPlan,
  ): Promise<ReleaseImageSet> {
    const output = join(this.workRoot, `${phase}.json`);
    await rm(output, { force: true });
    await this.runPhase(phase, plan, output);
    return await readBoundedJson(output, MAX_RESULT_BYTES, phase) as ReleaseImageSet;
  }

  private async runPhase(
    phase: 'preflight' | 'build' | 'transition' | 'verify',
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
      arguments: this.resolvedFixtureNetwork
        ? { ...this.args, fixtureNetwork: this.resolvedFixtureNetwork }
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
    await runBounded(argv, candidateRoot, this.timeoutMs, phase);
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
): ResolvedFixtureNetworkBinding | undefined {
  const fixtureNetworkId = isRecord(raw) ? raw.fixtureNetworkId : undefined;
  const expectedKeys = fixtureNetwork ? ['fixtureNetworkId'] : [];
  if (role !== 'uploader') {
    if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', ...expectedKeys]) || raw.schemaVersion !== 1) {
      throw new Error('release adapter preflight result is invalid');
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
  if (!fixtureNetwork) return undefined;
  if (typeof fixtureNetworkId !== 'string' || !/^[0-9a-f]{64}$/.test(fixtureNetworkId)) {
    throw new Error('release adapter fixture network result is invalid');
  }
  return { ...fixtureNetwork, networkId: fixtureNetworkId };
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
  phase: 'preflight' | 'build' | 'transition' | 'verify',
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn('/bin/bash', argv, {
      cwd,
      env: adapterEnvironment(),
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

function adapterEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}
