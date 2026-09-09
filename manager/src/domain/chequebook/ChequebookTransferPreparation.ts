import { ChequebookProfileChangedError } from '../errors/ChequebookProfileChangedError.js';
import { parsePlur, type ChequebookOperation, type ChequebookTransferContext, type ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import type { ChequebookChainRegistry } from './ChequebookChainRegistry.js';
import type { PreparedChequebookTransfer } from './ChequebookSubmission.js';
import { normalizeTransferContext, normalizeTransferIntent, sameTransferIntent } from './operationIdentity.js';
import { PinnedBeeSession, normalizePinnedBeeSessionOptions, type BeeTransferSession } from './PinnedBeeSession.js';
import { tokenAddressForChain } from './transactionIdentity.js';
import { sameFrozenTarget, type FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { normalizeDockerBeeAcquisitionOptions, type DockerBeeAcquisitionOptions, type AcquiredDockerBeeStream } from './acquireDockerBeeStream.js';
import { requireBeeBindingTarget } from './DockerBeeBinding.js';

/** A saved locator, not proof of current Docker ownership. Topology is asserted by the operator. */
export interface ConfiguredBeeTarget {
  readonly topology: 'operator_asserted_direct';
  readonly profileInstanceId: string;
  readonly url: string;
  readonly revision: string;
}
export type ResolveConfiguredBeeTarget = (profileName: string) => Promise<ConfiguredBeeTarget>;

export interface OwnedTransferPreparationOptions extends DockerBeeAcquisitionOptions {
  timeoutMs?: number;
  readTimeoutMs?: number;
  maxResponseBytes?: number;
}
export type CaptureTransferTarget = (profileName: string, profileInstanceId: string) => Promise<FrozenChequebookTarget>;
export type AcquireBoundBeeStream = (target: FrozenChequebookTarget, budgets: Readonly<DockerBeeAcquisitionOptions>, lifetime: AbortSignal) => Promise<AcquiredDockerBeeStream>;
interface TransferTargetLease {
  readonly session: BeeTransferSession;
  readonly submissionTarget?: FrozenChequebookTarget;
  recheck(signal: AbortSignal): Promise<void>;
  dispose(): void;
}
type AcquireTransferTarget = (intent: ChequebookTransferIntent, step: AbortSignal, lifetime: AbortSignal) => Promise<TransferTargetLease>;

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

class TransferPreparation {
  private readonly timeoutMs: number;

  constructor(private readonly acquireTarget: AcquireTransferTarget, private readonly chains: ChequebookChainRegistry,
    options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new ChequebookPreparationError();
  }

  async prepare(input: ChequebookTransferIntent): Promise<PreparedChequebookTransfer> {
    const intent = normalizeTransferIntent(input);
    let lease: TransferTargetLease | undefined;
    const lifetime = new AbortController();
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; lifetime.abort(); lease?.dispose(); } };
    try {
      return await this.bounded(async signal => {
        const acquired = await this.acquireTarget(intent, signal, lifetime.signal);
        if (disposed || signal.aborted) { acquired.dispose(); throw new ChequebookPreparationError(); }
        lease = acquired;
        const pinnedSession = acquired.session;
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
        return Object.freeze<PreparedChequebookTransfer>({
          context, dispose, submissionTarget: acquired.submissionTarget,
          preflight: async operation => {
            try {
              await this.bounded(async preflightSignal => {
                requireOperation(operation);
                if (disposed) throw new ChequebookPreparationError();
                await acquired.recheck(preflightSignal);
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
            if (disposed) throw new ChequebookPreparationError();
            requireOperation(operation);
            pinnedSession.assertUsable();
            return intent.direction === 'deposit' ? pinnedSession.depositChequebook(BigInt(intent.amountPlur)) : pinnedSession.withdrawChequebook(BigInt(intent.amountPlur));
          },
        });
      });
    } catch (error) { dispose(); throw error instanceof ChequebookProfileChangedError ? error : new ChequebookPreparationError(); }
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

function frozenTarget(value: FrozenChequebookTarget, intent: ChequebookTransferIntent): FrozenChequebookTarget {
  const target = structuredClone(value);
  if (target?.profile?.name !== intent.profileName) throw new ChequebookPreparationError();
  if (target.profile.instanceId !== intent.profileInstanceId) throw new ChequebookProfileChangedError();
  if (target.profile.components) Object.freeze(target.profile.components);
  Object.freeze(target.profile); Object.freeze(target.reservation);
  return Object.freeze(target);
}

export class ChequebookTransferPreparation extends TransferPreparation {
  constructor(resolveTarget: ResolveConfiguredBeeTarget, chains: ChequebookChainRegistry,
    createSession: (url: string) => BeeTransferSession = url => new PinnedBeeSession(url), options: { timeoutMs?: number } = {}) {
    super(async (intent, step) => {
      const target = Object.freeze({ ...await checked(resolveTarget(intent.profileName), step) });
      if (target.topology !== 'operator_asserted_direct' || !target.revision) throw new ChequebookPreparationError();
      if (target.profileInstanceId !== intent.profileInstanceId) throw new ChequebookProfileChangedError();
      const session = createSession(target.url);
      return { session, dispose: () => session.dispose(), recheck: async signal => {
        const current = await checked(resolveTarget(intent.profileName), signal);
        if (current.profileInstanceId !== intent.profileInstanceId || current.topology !== target.topology || current.revision !== target.revision || current.url !== target.url) throw new ChequebookPreparationError();
      } };
    }, chains, options);
  }

  /** Inactive owned-target entrypoint. The injected acquirer must use the qualified pinned Docker handshake. */
  static fromOwnedTarget(captureTarget: CaptureTransferTarget, acquireBoundStream: AcquireBoundBeeStream,
    chains: ChequebookChainRegistry, options: OwnedTransferPreparationOptions = {}): Pick<ChequebookTransferPreparation, 'prepare'> {
    try {
      const copied = structuredClone(options);
      const sessionOptions = normalizePinnedBeeSessionOptions(copied);
      const budgets = normalizeDockerBeeAcquisitionOptions({ ...copied, preflightTimeoutMs: sessionOptions.preflightTimeoutMs, postTimeoutMs: sessionOptions.postTimeoutMs });
      return new TransferPreparation(async (intent, step, lifetime) => {
        const target = frozenTarget(await checked(captureTarget(intent.profileName, intent.profileInstanceId), step), intent);
        const acquired = await acquireBoundStream(target, budgets, lifetime);
        try {
          step.throwIfAborted(); lifetime.throwIfAborted();
          requireBeeBindingTarget(structuredClone(acquired.binding), target);
          const session = PinnedBeeSession.fromStream(acquired.stream, sessionOptions);
          return { session, submissionTarget: target, dispose: () => session.dispose(), recheck: async signal => {
            const current = frozenTarget(await checked(captureTarget(intent.profileName, intent.profileInstanceId), signal), intent);
            if (!sameFrozenTarget(target, current)) throw new ChequebookPreparationError();
          } };
        } catch { acquired.stream.destroy(); throw new ChequebookPreparationError(); }
      }, chains, { timeoutMs: copied.timeoutMs });
    } catch { throw new ChequebookPreparationError(); }
  }
}
