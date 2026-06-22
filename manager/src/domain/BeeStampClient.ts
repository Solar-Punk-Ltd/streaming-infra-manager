import { BeeHttpError } from './errors/BeeHttpError.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const BUY_TIMEOUT_MS = 180_000;

export interface BeeAddresses {
  ethereum: string;
  overlay?: string;
  underlay?: string[];
}

export interface BeeWallet {
  bzzBalance: string;
  nativeTokenBalance: string;
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

export interface BeeChainState {
  chainTip: number;
  block: number;
  totalAmount: string;
  currentPrice: string;
}

export class BeeStampClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

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
      BUY_TIMEOUT_MS,
    );
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
