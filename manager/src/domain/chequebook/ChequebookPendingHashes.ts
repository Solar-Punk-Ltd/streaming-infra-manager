import type { ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChainReadError } from '../errors/ChainReadError.js';
import { PinnedBeeSession, type BeeTransferSession } from './PinnedBeeSession.js';
import { readBeeTransferIdentity, type ResolveConfiguredBeeTarget } from './ChequebookTransferPreparation.js';
import { recoveryHashes } from './recoveryObservation.js';

type PendingSession = Pick<BeeTransferSession, 'getAddresses' | 'getWallet' | 'getChequebookAddress' | 'dispose'> & { getPendingTransactions(): Promise<unknown> };
type SavedIdentity = ChequebookTransferContext & Pick<ChequebookTransferIntent, 'profileName'>;

/** A missing or replaced Bee means an unavailable pending list, never an empty one. */
export class ChequebookPendingHashes {
  constructor(private readonly resolveTarget: ResolveConfiguredBeeTarget,
    private readonly createSession: (url: string) => PendingSession = url => new PinnedBeeSession(url)) {}

  async read(operation: SavedIdentity, signal: AbortSignal): Promise<readonly string[]> {
    let session: PendingSession | undefined;
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ChainReadError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const observe = async () => {
        const target = await this.resolveTarget(operation.profileName);
        signal.throwIfAborted();
        if (target.topology !== 'operator_asserted_direct') throw new ChainReadError();
        session = this.createSession(target.url);
        const identity = await readBeeTransferIdentity(session, signal);
        if (identity.chainId !== operation.chainId || identity.nodeAddress !== operation.nodeAddress ||
            identity.chequebookAddress !== operation.chequebookAddress || identity.tokenAddress !== operation.tokenAddress) throw new ChainReadError();
        const value = await session.getPendingTransactions();
        signal.throwIfAborted();
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
      if (onAbort) signal.removeEventListener('abort', onAbort);
      session?.dispose();
    }
  }
}
