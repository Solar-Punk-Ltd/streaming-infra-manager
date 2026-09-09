import type { ChequebookTransferContext, ChequebookOperation } from '@streaming-infra-manager/common';
import { performance } from 'node:perf_hooks';
import { ChainReadError } from '../errors/ChainReadError.js';
import { PinnedBeeSession, normalizePinnedBeeSessionOptions, type BeeTransferSession } from './PinnedBeeSession.js';
import { readBeeTransferIdentity, type ResolveConfiguredBeeTarget, type CaptureTransferTarget, type AcquireBoundBeeStream, type OwnedTransferPreparationOptions } from './ChequebookTransferPreparation.js';
import { recoveryHashes } from './recoveryObservation.js';
import { requireBeeBindingTarget } from './DockerBeeBinding.js';
import { normalizeDockerBeeAcquisitionOptions } from './acquireDockerBeeStream.js';

type PendingSession = Pick<BeeTransferSession, 'getAddresses' | 'getWallet' | 'getChequebookAddress' | 'dispose'> & { getPendingTransactions(): Promise<unknown> };
type SavedIdentity = ChequebookTransferContext & Pick<ChequebookOperation, 'profileName' | 'profileInstanceId'>;
type AcquirePendingSession = (identity: SavedIdentity, signal: AbortSignal, deadline: number) => Promise<PendingSession>;

function requireActive(signal: AbortSignal, deadline: number): void {
  if (signal.aborted || performance.now() >= deadline) throw new ChainReadError();
}

/** A missing or replaced Bee means an unavailable pending list, never an empty one. */
class PendingHashesReader {
  constructor(private readonly acquire: AcquirePendingSession, private readonly timeoutMs = 30000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new ChainReadError();
  }

  async read(input: SavedIdentity, signal: AbortSignal): Promise<readonly string[]> {
    let session: PendingSession | undefined;
    let onAbort: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const lifetime = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    try {
      signal.throwIfAborted();
      const operation = structuredClone(input);
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => { lifetime.abort(); reject(new ChainReadError()); };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, Math.max(1, deadline - performance.now()));
      });
      const observe = async () => {
        const acquired = await this.acquire(operation, lifetime.signal, deadline);
        try { requireActive(lifetime.signal, deadline); }
        catch { acquired.dispose(); throw new ChainReadError(); }
        session = acquired;
        const identity = await readBeeTransferIdentity(session, lifetime.signal, deadline);
        if (identity.chainId !== operation.chainId || identity.nodeAddress !== operation.nodeAddress ||
            identity.chequebookAddress !== operation.chequebookAddress || identity.tokenAddress !== operation.tokenAddress) throw new ChainReadError();
        const value = await session.getPendingTransactions();
        requireActive(lifetime.signal, deadline);
        if (!value || typeof value !== 'object' || !('pendingTransactions' in value) || !Array.isArray(value.pendingTransactions)) throw new ChainReadError();
        // Bee v2.8.2 transaction.go returns pendingTransactions with transactionHash on each entry.
        return recoveryHashes(value.pendingTransactions.map(entry => {
          if (!entry || typeof entry !== 'object' || !('transactionHash' in entry)) throw new ChainReadError();
          return entry.transactionHash;
        }));
      };
      return await Promise.race([observe(), cancelled]);
    } catch { throw new ChainReadError(); }
    finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      lifetime.abort();
      session?.dispose();
    }
  }
}

export class ChequebookPendingHashes extends PendingHashesReader {
  constructor(resolveTarget: ResolveConfiguredBeeTarget, createSession: (url: string) => PendingSession = url => new PinnedBeeSession(url)) {
    super(async (operation, signal, deadline) => {
      requireActive(signal, deadline);
      const target = await resolveTarget(operation.profileName);
      requireActive(signal, deadline);
      if (target.topology !== 'operator_asserted_direct') throw new ChainReadError();
      return createSession(target.url);
    });
  }

  static fromOwnedTarget(captureTarget: CaptureTransferTarget, acquireBoundStream: AcquireBoundBeeStream,
    options: OwnedTransferPreparationOptions = {}): Pick<ChequebookPendingHashes, 'read'> {
    try {
      const copied = structuredClone(options);
      const sessionOptions = normalizePinnedBeeSessionOptions(copied);
      const budgets = normalizeDockerBeeAcquisitionOptions({ ...copied, preflightTimeoutMs: sessionOptions.preflightTimeoutMs, postTimeoutMs: sessionOptions.postTimeoutMs });
      return new PendingHashesReader(async (operation, signal, deadline) => {
        requireActive(signal, deadline);
        if (!operation.profileInstanceId) throw new ChainReadError();
        const target = structuredClone(await captureTarget(operation.profileName, operation.profileInstanceId));
        requireActive(signal, deadline);
        if (target?.profile?.name !== operation.profileName || target.profile.instanceId !== operation.profileInstanceId) throw new ChainReadError();
        if (target.profile.components) Object.freeze(target.profile.components);
        Object.freeze(target.profile); Object.freeze(target.reservation); Object.freeze(target);
        const acquired = await acquireBoundStream(target, budgets, signal);
        try {
          requireActive(signal, deadline);
          requireBeeBindingTarget(structuredClone(acquired.binding), target);
          requireActive(signal, deadline);
          return PinnedBeeSession.fromStream(acquired.stream, sessionOptions);
        } catch { acquired.stream.destroy(); throw new ChainReadError(); }
      }, copied.timeoutMs);
    } catch { throw new ChainReadError(); }
  }
}
