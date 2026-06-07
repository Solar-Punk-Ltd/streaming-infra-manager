/**
 * Thin client for a bee node's HTTP API (the per-profile bee-uploader node).
 * Uses Node's global fetch — no bee-js / submodule node_modules needed in the
 * api container. Only the endpoints required for postage-stamp management.
 *
 * Bee API reference: https://docs.ethswarm.org/api/
 */

const DEFAULT_TIMEOUT_MS = 10_000;
// Buying a stamp submits an on-chain transaction (Gnosis Chain) and the bee API
// blocks until it's mined — well beyond the read timeout.
const BUY_TIMEOUT_MS = 180_000;

export interface BeeAddresses {
  ethereum: string;
  overlay?: string;
  underlay?: string[];
}

export interface BeeWallet {
  /** PLUR (1 BZZ = 1e16 PLUR), as a decimal string. */
  bzzBalance: string;
  /** wei xDAI, as a decimal string. */
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
  /** Seconds of remaining life, or -1 when unknown. */
  batchTTL: number;
}

export interface BuyStampInput {
  amount: string;
  depth: number;
  label?: string;
  immutable?: boolean;
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
    if (input.immutable) headers.immutable = 'true';
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
      throw new Error(`bee ${method} ${path} → ${res.status}: ${detail}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`bee ${method} ${path} returned non-JSON body`);
    }
  }
}
