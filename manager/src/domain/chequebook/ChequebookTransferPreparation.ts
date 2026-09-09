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
import { performance } from 'node:perf_hooks';

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
interface PreparationStep { readonly signal: AbortSignal; readonly deadline: number }
interface TransferTargetLease {
  readonly session: BeeTransferSession;
  readonly submissionTarget?: FrozenChequebookTarget;
  recheck(step: PreparationStep): Promise<void>;
  dispose(): void;
}
type AcquireTransferTarget = (intent: ChequebookTransferIntent, step: PreparationStep, lifetime: AbortSignal) => Promise<TransferTargetLease>;

function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new ChequebookPreparationError();
  return value.toLowerCase();
}

function requireActiveStep(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (performance.now() >= deadline) throw new ChequebookPreparationError();
}

async function checked<T>(action: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  requireActiveStep(signal, deadline);
  const result = await action();
  requireActiveStep(signal, deadline);
  return result;
}

/** Fresh identity is read on the same connection that may later carry the single POST. */
export async function readBeeTransferIdentity(session: Pick<BeeTransferSession, 'getAddresses' | 'getWallet' | 'getChequebookAddress'>, signal: AbortSignal, deadline = Infinity) {
  const addresses = await checked(() => session.getAddresses(), signal, deadline);
  const wallet = await checked(() => session.getWallet(), signal, deadline);
  const chequebook = await checked(() => session.getChequebookAddress(), signal, deadline);
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
      return await this.bounded(async step => {
        const acquired = await this.acquireTarget(intent, step, lifetime.signal);
        if (disposed || step.signal.aborted) { acquired.dispose(); throw new ChequebookPreparationError(); }
        lease = acquired;
        requireActiveStep(step.signal, step.deadline);
        const pinnedSession = acquired.session;
        const identity = await readBeeTransferIdentity(pinnedSession, step.signal, step.deadline);
        const reader = await checked(() => this.chains.forChain(identity.chainId, step.signal), step.signal, step.deadline);
        const start = await checked(() => reader.blockHeader('latest', step.signal), step.signal, step.deadline);
        if (!start) throw new ChequebookPreparationError();
        const number = BigInt(start.number);
        const nonce = await checked(() => reader.transactionCount(identity.nodeAddress, number, step.signal), step.signal, step.deadline);
        const confirmed = await checked(() => reader.blockHeader(number, step.signal), step.signal, step.deadline);
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
              await this.bounded(async preflight => {
                requireOperation(operation);
                if (disposed) throw new ChequebookPreparationError();
                await acquired.recheck(preflight);
                const fresh = await readBeeTransferIdentity(pinnedSession, preflight.signal, preflight.deadline);
                if (!sameIdentity(context, fresh)) throw new ChequebookPreparationError();
                const gas = parsePlur(fresh.wallet.nativeTokenBalance);
                if (gas === null || gas < 1n) throw new ChequebookPreparationError();
                const amount = BigInt(intent.amountPlur);
                const available = intent.direction === 'deposit' ? parsePlur(fresh.wallet.bzzBalance) :
                  parsePlur((await checked(() => pinnedSession.getChequebookBalance(), preflight.signal, preflight.deadline)).availableBalance);
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

  private async bounded<T>(action: (step: PreparationStep) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const step = { signal: controller.signal, deadline: performance.now() + this.timeoutMs };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expires = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ChequebookPreparationError()); }, this.timeoutMs);
      });
      const result = await Promise.race([action(step), expires]);
      requireActiveStep(step.signal, step.deadline);
      return result;
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
      const target = Object.freeze({ ...await checked(() => resolveTarget(intent.profileName), step.signal, step.deadline) });
      if (target.topology !== 'operator_asserted_direct' || !target.revision) throw new ChequebookPreparationError();
      if (target.profileInstanceId !== intent.profileInstanceId) throw new ChequebookProfileChangedError();
      requireActiveStep(step.signal, step.deadline);
      const session = createSession(target.url);
      return { session, dispose: () => session.dispose(), recheck: async currentStep => {
        const current = await checked(() => resolveTarget(intent.profileName), currentStep.signal, currentStep.deadline);
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
        const target = frozenTarget(await checked(() => captureTarget(intent.profileName, intent.profileInstanceId), step.signal, step.deadline), intent);
        requireActiveStep(step.signal, step.deadline);
        const acquired = await acquireBoundStream(target, budgets, lifetime);
        try {
          requireActiveStep(step.signal, step.deadline); lifetime.throwIfAborted();
          requireBeeBindingTarget(structuredClone(acquired.binding), target);
          requireActiveStep(step.signal, step.deadline);
          const session = PinnedBeeSession.fromStream(acquired.stream, sessionOptions);
          return { session, submissionTarget: target, dispose: () => session.dispose(), recheck: async currentStep => {
            const current = frozenTarget(await checked(() => captureTarget(intent.profileName, intent.profileInstanceId), currentStep.signal, currentStep.deadline), intent);
            if (!sameFrozenTarget(target, current)) throw new ChequebookPreparationError();
          } };
        } catch { acquired.stream.destroy(); throw new ChequebookPreparationError(); }
      }, chains, { timeoutMs: copied.timeoutMs });
    } catch { throw new ChequebookPreparationError(); }
  }
}
