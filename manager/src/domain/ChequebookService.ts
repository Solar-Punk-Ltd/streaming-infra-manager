import {
  type BeeTransaction,
  type ChequebookBalance,
  chequebookHealthFrom,
  chequebookHealthPayload,
  type ChequebookSummary,
  depositOverWalletReason,
  getErrorMessage,
  isChequebookShort,
  NO_XDAI_FOR_GAS_REASON,
  parsePlur,
  plurToBzz,
  withdrawalOverChequebookReason,
} from '@streaming-infra-manager/common';

import { BeeClient } from './BeeClient.js';
import { beeCallFailed } from './beeFailure.js';
import {
  BeeNodeError,
  ChequebookBusyError,
  ChequebookFundsError,
  ChequebookUnfundedError,
  ProfileNotFoundError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { beeApiUrlFor, type BeeClientFactory } from './StampService.js';

const logger = Logger.getInstance();

/**
 * What a deployment's own bee node can still pay its peers with, and the two
 * moves that change it.
 *
 * The reason this exists as its own service rather than as more methods on
 * StampService: a stamp is prepaid storage and a chequebook is the ongoing
 * payment for having that storage forwarded, and they run out independently.
 * A node with a fat batch and a dry chequebook accepts every upload and lands
 * none of them.
 */
export class ChequebookService {
  private readonly transfersInFlight = new Set<string>();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly floorPlur: bigint,
    private readonly events: EventBus,
    private readonly clientFactory: BeeClientFactory = (url, timeoutMs) =>
      new BeeClient(url, timeoutMs),
  ) {}

  /** The floor as an operator reads it, so the UI can quote the gate's number. */
  get floorBzz(): string {
    return plurToBzz(this.floorPlur);
  }

  /**
   * Everything the storage card shows about the chequebook, in one answer.
   *
   * The three calls are independent and so are their failures: a node that
   * cannot list its settlements can still report a balance worth acting on, so
   * each piece comes back on its own and a missing one is null rather than an
   * error for the whole page.
   */
  async summary(name: string): Promise<ChequebookSummary> {
    const client = await this.clientFor(name);
    const [address, balance, settlements] = await Promise.allSettled([
      client.getChequebookAddress(),
      client.getChequebookBalance(),
      client.getSettlements(),
    ]);

    const reportedAddress = this.reported(name, address, 'chequebook address');
    const reportedBalance = this.reported(name, balance, 'chequebook balance');
    const reportedSettlements = this.reported(name, settlements, 'settlements');

    return {
      address: reportedAddress?.chequebookAddress ?? null,
      totalBalance: reportedBalance?.totalBalance ?? null,
      availableBalance: reportedBalance?.availableBalance ?? null,
      totalSent: reportedSettlements?.totalSent ?? null,
      totalReceived: reportedSettlements?.totalReceived ?? null,
      health: chequebookHealthPayload(
        chequebookHealthFrom(reportedBalance, this.floorPlur),
      ),
    };
  }

  /** Wallet to chequebook, an on-chain transaction the node pays gas for. */
  async deposit(name: string, amountPlur: bigint): Promise<BeeTransaction> {
    return this.asTheOnlyTransfer(name, async () => {
      const client = await this.clientFor(name);
      const wallet = await this.ask(name, () => client.getWallet());

      const bzz = parsePlur(wallet.bzzBalance) ?? 0n;
      if (bzz < amountPlur) {
        throw new ChequebookFundsError(
          depositOverWalletReason(bzz, amountPlur),
        );
      }
      if ((parsePlur(wallet.nativeTokenBalance) ?? 0n) === 0n) {
        throw new ChequebookFundsError(NO_XDAI_FOR_GAS_REASON);
      }

      const result = await this.ask(name, () =>
        client.depositChequebook(amountPlur),
      );
      logger.info(
        `[ChequebookService] ${name}: deposit of ${plurToBzz(amountPlur)} BZZ submitted, tx ${result.transactionHash}`,
      );
      return result;
    });
  }

  /** Chequebook back to wallet, limited to what is not already promised out. */
  async withdraw(name: string, amountPlur: bigint): Promise<BeeTransaction> {
    return this.asTheOnlyTransfer(name, async () => {
      const client = await this.clientFor(name);
      const balance = await this.ask(name, () => client.getChequebookBalance());

      const available = parsePlur(balance.availableBalance) ?? 0n;
      if (available < amountPlur) {
        throw new ChequebookFundsError(
          withdrawalOverChequebookReason(available, amountPlur),
        );
      }

      const result = await this.ask(name, () =>
        client.withdrawChequebook(amountPlur),
      );
      logger.info(
        `[ChequebookService] ${name}: withdrawal of ${plurToBzz(amountPlur)} BZZ submitted, tx ${result.transactionHash}`,
      );
      return result;
    });
  }

  /**
   * The uploader gate: refuse to start one whose node cannot pay for uploads.
   *
   * A node that does not answer is a refusal too. An uploader started with
   * its funding unverified looks exactly like one that was checked, right up
   * until nothing it uploads lands. The refusal says how to try again, and
   * a stopped deployment's start does not ask, so the operator always has a
   * way through.
   */
  async assertFunded(name: string): Promise<void> {
    const client = await this.clientFor(name);

    let balance: ChequebookBalance;
    try {
      balance = await client.getChequebookBalance();
    } catch (err) {
      throw new BeeNodeError(
        name,
        `The Bee node of ${name} did not answer the chequebook check (${getErrorMessage(err)}), so the uploader was not started. Try again once the node answers.`,
      );
    }

    const health = chequebookHealthFrom(balance, this.floorPlur);
    if (health.state === 'unknown') {
      throw new BeeNodeError(
        name,
        `The Bee node of ${name} answered the chequebook check with a balance that could not be read, so the uploader was not started. Try again once the node answers properly.`,
      );
    }
    if (isChequebookShort(health.state)) {
      throw new ChequebookUnfundedError(name, health);
    }
  }

  /**
   * One transfer per node at a time, refusing the second rather than queueing.
   *
   * The balance check and the submit are two separate calls to bee, and a
   * request arriving between them reads a balance the first one has already
   * spoken for. Held only until bee has answered the submit with a transaction
   * hash, not until that transaction is mined: the operator's dialog watches
   * for the balance to move, and holding the node for two minutes would refuse
   * a second, perfectly fundable transfer.
   */
  private async asTheOnlyTransfer<T>(
    name: string,
    move: () => Promise<T>,
  ): Promise<T> {
    if (this.transfersInFlight.has(name)) throw new ChequebookBusyError(name);
    this.transfersInFlight.add(name);
    try {
      return await move();
    } finally {
      this.transfersInFlight.delete(name);
    }
  }

  private async clientFor(name: string): Promise<BeeClient> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    return this.clientFactory(beeApiUrlFor(profile));
  }

  private async ask<T>(name: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw beeCallFailed(name, err);
    }
  }

  private reported<T>(
    name: string,
    result: PromiseSettledResult<T>,
    what: string,
  ): T | null {
    if (result.status === 'fulfilled') return result.value;
    logger.debug(
      `[ChequebookService] ${name}: no ${what}: ${getErrorMessage(result.reason)}`,
    );
    return null;
  }
}
