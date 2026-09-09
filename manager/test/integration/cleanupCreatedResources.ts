import { performance } from 'node:perf_hooks';

import type {
  CreatedGroupIdentity, CreatedProfileIdentity, CreatedResourceSnapshot, UnresolvedCreation,
} from './createdResources.js';

export interface CleanupAdapter {
  /** Atomically compare the instance id at removal admission. Never issue a name-only DELETE. */
  remove(profile: CreatedProfileIdentity, signal: AbortSignal): Promise<'accepted' | 'absent' | 'replaced'>;
  read(profile: CreatedProfileIdentity, signal: AbortSignal): Promise<'present' | 'absent' | 'replaced'>;
  /** Atomically require this group identity and empty membership. Never cascade or use GET-then-DELETE. */
  removeEmptyGroup(group: CreatedGroupIdentity, signal: AbortSignal): Promise<'accepted' | 'absent' | 'changed' | 'not-empty'>;
  groupExists(group: CreatedGroupIdentity, signal: AbortSignal): Promise<boolean>;
}

export interface CleanupOptions {
  requestTimeoutMs?: number;
  removalTimeoutMs?: number;
  intervalMs?: number;
}

type StepFailureReason = 'request-failed' | 'request-timeout' | 'removal-timeout' | 'invalid-response'
  | 'identity-changed' | 'group-not-empty';

export type CleanupFailure =
  | { readonly kind: 'profile'; readonly profile: CreatedProfileIdentity; readonly stage: 'remove' | 'wait'; readonly reason: StepFailureReason }
  | { readonly kind: 'group'; readonly group: CreatedGroupIdentity; readonly stage: 'remove' | 'wait'; readonly reason: StepFailureReason }
  | ({ readonly kind: 'creation' } & Omit<UnresolvedCreation, 'kind'> & { readonly operation: UnresolvedCreation['kind'] });

function failureMessage(failure: CleanupFailure): string {
  if (failure.kind === 'creation') return `Unresolved ${failure.operation} creation: ${failure.reason}`;
  const resource = failure.kind === 'profile'
    ? `profile ${failure.profile.name} instance ${failure.profile.instanceId}`
    : `group ${failure.group.id} (${failure.group.name})`;
  return `${resource}: ${failure.stage} ${failure.reason}`;
}

export class IntegrationCleanupError extends AggregateError {
  readonly failures: readonly CleanupFailure[];

  constructor(failures: readonly CleanupFailure[]) {
    const messages = failures.map(failureMessage);
    super(messages.map(message => new Error(message)), `Integration cleanup incomplete. ${messages.join('. ')}`);
    this.name = 'IntegrationCleanupError';
    this.failures = Object.freeze(failures.map(failure => Object.freeze(failure)));
  }
}

class StepFailure extends Error {
  constructor(readonly reason: StepFailureReason) { super(reason); }
}

function reasonOf(error: unknown): StepFailureReason {
  return error instanceof StepFailure ? error.reason : 'request-failed';
}

/** The deadline covers request headers and body decoding. An abort is never followed by a retry. */
async function bounded<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StepFailure('request-timeout'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => request(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function waitUntilGone(
  absent: (signal: AbortSignal) => Promise<boolean>,
  requestTimeoutMs: number,
  removalTimeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = performance.now() + removalTimeoutMs;
  while (performance.now() < deadline) {
    if (await bounded(absent, Math.min(requestTimeoutMs, Math.max(1, deadline - performance.now())))) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  throw new StepFailure('removal-timeout');
}

/** Run only against an adapter with atomic ownership preconditions. The live adapter is not wired yet. */
export async function cleanupCreatedResources(
  snapshot: CreatedResourceSnapshot,
  adapter: CleanupAdapter,
  options: CleanupOptions = {},
): Promise<void> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const removalTimeoutMs = options.removalTimeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  if (![requestTimeoutMs, removalTimeoutMs, intervalMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error('Cleanup timeouts and polling interval must be positive timer-safe integers');
  }
  const failures: CleanupFailure[] = [];
  for (const profile of snapshot.profiles) {
    let stage: 'remove' | 'wait' = 'remove';
    try {
      const result = await bounded(signal => adapter.remove(profile, signal), requestTimeoutMs);
      if (result === 'absent' || result === 'replaced') continue;
      if (result !== 'accepted') throw new StepFailure('invalid-response');
      stage = 'wait';
      await waitUntilGone(async signal => {
        const state = await adapter.read(profile, signal);
        if (state === 'absent' || state === 'replaced') return true;
        if (state === 'present') return false;
        throw new StepFailure('invalid-response');
      }, requestTimeoutMs, removalTimeoutMs, intervalMs);
    } catch (error) {
      failures.push({ kind: 'profile', profile, stage, reason: reasonOf(error) });
    }
  }
  for (const group of snapshot.groups) {
    let stage: 'remove' | 'wait' = 'remove';
    try {
      const result = await bounded(signal => adapter.removeEmptyGroup(group, signal), requestTimeoutMs);
      if (result === 'absent') continue;
      if (result === 'changed') throw new StepFailure('identity-changed');
      if (result === 'not-empty') throw new StepFailure('group-not-empty');
      if (result !== 'accepted') throw new StepFailure('invalid-response');
      stage = 'wait';
      await waitUntilGone(async signal => {
        const exists = await adapter.groupExists(group, signal);
        if (typeof exists !== 'boolean') throw new StepFailure('invalid-response');
        return !exists;
      }, requestTimeoutMs, removalTimeoutMs, intervalMs);
    } catch (error) {
      failures.push({ kind: 'group', group, stage, reason: reasonOf(error) });
    }
  }
  for (const issue of snapshot.unresolved) {
    failures.push({ kind: 'creation', operation: issue.kind, reason: issue.reason });
  }
  if (failures.length) throw new IntegrationCleanupError(failures);
}
