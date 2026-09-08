import type {
  BeeTransaction,
  BeeNodeObservation,
  ChequebookBalance,
} from '@streaming-infra-manager/common';

import { observeBeeNode } from './beeNodeObservation.js';
import { BeeHttpError } from './errors/BeeHttpError.js';

const DEFAULT_TIMEOUT_MS = 10_000;
// Buying a stamp, filling a chequebook and emptying one all submit a
// transaction to Gnosis Chain, and bee holds the request until it has one to
// answer with.
const ON_CHAIN_TIMEOUT_MS = 180_000;

export interface BeeAddresses {
  ethereum: string;
  overlay?: string;
  underlay?: string[];
}

export interface BeeWallet {
  bzzBalance: string;
  nativeTokenBalance: string;
  walletAddress?: string;
  chequebookContractAddress?: string;
  chainID?: number;
}

export interface BeeStamp {
  batchID: string;
  utilization: number;
  usable: boolean;
  label?: string;
  depth: number;
  amount: string;
  bucketDepth: number;
  blockNumber: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
}

export interface BuyStampInput {
  amount: string;
  depth: number;
  label?: string;
  immutable?: boolean;
}

export interface BeeChequebookAddress {
  chequebookAddress: string;
}

/**
 * Cheques this node has written to peers and taken from them, in PLUR.
 *
 * Bee also returns a per peer breakdown. Nothing here reads it, and typing a
 * field means claiming to know its shape, so only the two totals are declared.
 */
export interface BeeSettlements {
  totalSent: string;
  totalReceived: string;
}

export interface BeeChainState {
  chainTip: number;
  block: number;
  totalAmount: string;
  currentPrice: string;
}

export class BeeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async getNodeObservation(): Promise<BeeNodeObservation> {
    return observeBeeNode(this.baseUrl, this.timeoutMs);
  }

  async getAddresses(): Promise<BeeAddresses> {
    return this.request<BeeAddresses>('GET', '/addresses');
  }

  async getWallet(): Promise<BeeWallet> {
    return this.request<BeeWallet>('GET', '/wallet');
  }

  async getChainState(): Promise<BeeChainState> {
    return this.request<BeeChainState>('GET', '/chainstate');
  }

  async listStamps(): Promise<BeeStamp[]> {
    const body = await this.request<{ stamps: BeeStamp[] }>('GET', '/stamps');
    return body.stamps ?? [];
  }

  async getStamp(batchId: string): Promise<BeeStamp> {
    return this.request<BeeStamp>(
      'GET',
      `/stamps/${encodeURIComponent(batchId)}`,
    );
  }

  async buyStamp(input: BuyStampInput): Promise<{ batchID: string }> {
    const query = input.label
      ? `?label=${encodeURIComponent(input.label)}`
      : '';
    const headers: Record<string, string> = {};
    if (input.immutable !== undefined) {
      headers.immutable = input.immutable ? 'true' : 'false';
    }
    return this.request<{ batchID: string }>(
      'POST',
      `/stamps/${encodeURIComponent(input.amount)}/${input.depth}${query}`,
      headers,
      ON_CHAIN_TIMEOUT_MS,
    );
  }

  async getChequebookAddress(): Promise<BeeChequebookAddress> {
    return this.request<BeeChequebookAddress>('GET', '/chequebook/address');
  }

  async getChequebookBalance(): Promise<ChequebookBalance> {
    return this.request<ChequebookBalance>('GET', '/chequebook/balance');
  }

  /**
   * Move BZZ from the node's wallet into its chequebook.
   *
   * Bee answers once the transaction is submitted rather than once it is mined,
   * so the returned hash is a receipt for having asked. Gnosis blocks take about
   * five seconds, and the balance moves shortly after.
   */
  async depositChequebook(amountPlur: bigint): Promise<BeeTransaction> {
    return this.request<BeeTransaction>(
      'POST',
      `/chequebook/deposit?amount=${amountPlur.toString()}`,
      {},
      ON_CHAIN_TIMEOUT_MS,
    );
  }

  /** The same move in reverse, chequebook back to wallet. */
  async withdrawChequebook(amountPlur: bigint): Promise<BeeTransaction> {
    return this.request<BeeTransaction>(
      'POST',
      `/chequebook/withdraw?amount=${amountPlur.toString()}`,
      {},
      ON_CHAIN_TIMEOUT_MS,
    );
  }

  async getSettlements(): Promise<BeeSettlements> {
    return this.request<BeeSettlements>('GET', '/settlements');
  }

  private async request<T>(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`bee request ${method} ${path} failed: ${reason}`);
    }

    const text = await res.text();
    if (!res.ok) {
      const detail = text.trim().slice(0, 500) || `HTTP ${res.status}`;
      throw new BeeHttpError(
        res.status,
        `bee ${method} ${path} → ${res.status}: ${detail}`,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`bee ${method} ${path} returned non-JSON body`);
    }
  }
}
