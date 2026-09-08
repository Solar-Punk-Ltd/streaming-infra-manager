import { parsePlur, type ChequebookOperation, type ChequebookTransferContext, type ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import type { ChequebookChainRegistry } from './ChequebookChainRegistry.js';
import type { PreparedChequebookTransfer } from './ChequebookSubmission.js';
import { normalizeTransferContext, normalizeTransferIntent, sameTransferIntent } from './operationIdentity.js';
import { PinnedBeeSession, type BeeTransferSession } from './PinnedBeeSession.js';
import { tokenAddressForChain } from './transactionIdentity.js';

/** A saved locator, not proof of current Docker ownership. Topology is asserted by the operator. */
export interface ConfiguredBeeTarget {
  readonly topology: 'operator_asserted_direct';
  readonly url: string;
  readonly revision: string;
}
export type ResolveConfiguredBeeTarget = (profileName: string) => Promise<ConfiguredBeeTarget>;

function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new ChequebookPreparationError();
  return value.toLowerCase();
}

async function checked<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const result = await promise;
  signal.throwIfAborted();
  return result;
}

/** Fresh identity is read on the same connection that may later carry the single POST. */
export async function readBeeTransferIdentity(session: Pick<BeeTransferSession, 'getAddresses' | 'getWallet' | 'getChequebookAddress'>, signal: AbortSignal) {
  const addresses = await checked(session.getAddresses(), signal);
  const wallet = await checked(session.getWallet(), signal);
  const chequebook = await checked(session.getChequebookAddress(), signal);
  const nodeAddress = address(addresses.ethereum);
  const chequebookAddress = address(chequebook.chequebookAddress);
  if (nodeAddress !== address(wallet.walletAddress) || chequebookAddress !== address(wallet.chequebookContractAddress) ||
      !Number.isSafeInteger(wallet.chainID) || !wallet.chainID) throw new ChequebookPreparationError();
  const tokenAddress = tokenAddressForChain(wallet.chainID);
  if (!tokenAddress) throw new ChequebookPreparationError();
  return { chainId: wallet.chainID, nodeAddress, chequebookAddress, tokenAddress, wallet };
}

function sameIdentity(a: ChequebookTransferContext, b: Pick<ChequebookTransferContext, 'chainId' | 'nodeAddress' | 'chequebookAddress' | 'tokenAddress'>): boolean {
  return a.chainId === b.chainId && a.nodeAddress === b.nodeAddress && a.chequebookAddress === b.chequebookAddress && a.tokenAddress === b.tokenAddress;
}

export class ChequebookTransferPreparation {
  private readonly timeoutMs: number;

  constructor(private readonly resolveTarget: ResolveConfiguredBeeTarget,
    private readonly chains: ChequebookChainRegistry,
    private readonly createSession: (url: string) => BeeTransferSession = url => new PinnedBeeSession(url),
    options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new ChequebookPreparationError();
  }

  async prepare(input: ChequebookTransferIntent): Promise<PreparedChequebookTransfer> {
    const intent = normalizeTransferIntent(input);
    let session: BeeTransferSession | undefined;
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; session?.dispose(); } };
    try {
      return await this.bounded(async signal => {
        const target = Object.freeze({ ...await checked(this.resolveTarget(intent.profileName), signal) });
        if (target.topology !== 'operator_asserted_direct' || !target.revision) throw new ChequebookPreparationError();
        session = this.createSession(target.url);
        const pinnedSession = session;
        const identity = await readBeeTransferIdentity(pinnedSession, signal);
        const reader = await checked(this.chains.forChain(identity.chainId, signal), signal);
        const start = await checked(reader.blockHeader('latest', signal), signal);
        if (!start) throw new ChequebookPreparationError();
        const number = BigInt(start.number);
        const nonce = await checked(reader.transactionCount(identity.nodeAddress, number, signal), signal);
        const confirmed = await checked(reader.blockHeader(number, signal), signal);
        if (!confirmed || confirmed.number !== start.number || confirmed.hash !== start.hash) throw new ChequebookPreparationError();
        const context = normalizeTransferContext({ ...identity, startBlockNumber: start.number, startBlockHash: start.hash,
          nonceLowerBound: nonce, nonceQueryTag: `0x${number.toString(16)}` });
        pinnedSession.assertUsable();
        const requireOperation = (operation: ChequebookOperation) => {
          if (!sameTransferIntent(operation, intent) || !sameIdentity(context, operation) ||
              operation.startBlockNumber !== context.startBlockNumber || operation.startBlockHash !== context.startBlockHash ||
              operation.nonceLowerBound !== context.nonceLowerBound || operation.nonceQueryTag !== context.nonceQueryTag) throw new ChequebookPreparationError();
        };
        return {
          context, dispose,
          preflight: async operation => {
            try {
              await this.bounded(async preflightSignal => {
                requireOperation(operation);
                const current = await checked(this.resolveTarget(intent.profileName), preflightSignal);
                if (current.topology !== target.topology || current.revision !== target.revision || current.url !== target.url) throw new ChequebookPreparationError();
                const fresh = await readBeeTransferIdentity(pinnedSession, preflightSignal);
                if (!sameIdentity(context, fresh)) throw new ChequebookPreparationError();
                const gas = parsePlur(fresh.wallet.nativeTokenBalance);
                if (gas === null || gas < 1n) throw new ChequebookPreparationError();
                const amount = BigInt(intent.amountPlur);
                const available = intent.direction === 'deposit' ? parsePlur(fresh.wallet.bzzBalance) :
                  parsePlur((await checked(pinnedSession.getChequebookBalance(), preflightSignal)).availableBalance);
                if (available === null || available < amount) throw new ChequebookPreparationError();
                pinnedSession.assertUsable();
              });
            } catch { dispose(); throw new ChequebookPreparationError(); }
          },
          send: async operation => {
            requireOperation(operation);
            pinnedSession.assertUsable();
            return intent.direction === 'deposit' ? pinnedSession.depositChequebook(BigInt(intent.amountPlur)) : pinnedSession.withdrawChequebook(BigInt(intent.amountPlur));
          },
        };
      });
    } catch { dispose(); throw new ChequebookPreparationError(); }
  }

  private async bounded<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([action(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ChequebookPreparationError()); }, this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
