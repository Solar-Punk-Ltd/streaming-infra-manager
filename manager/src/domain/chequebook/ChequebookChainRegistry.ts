import { ChainReadError } from '../errors/ChainReadError.js';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { ChainRpc } from './ChainRpc.js';
import { tokenAddressForChain } from './transactionIdentity.js';

export type ChequebookChainReader = Pick<ChainRpc, 'chainId' | 'transactionCount' | 'transaction' | 'receipt' | 'blockHeader' | 'blockTransactions'>;
export type ChequebookEndpointMode = 'direct' | 'disabled';

export function chequebookEndpointMode(value: string | undefined): ChequebookEndpointMode {
  if (value === undefined || value === '' || value === 'disabled') return 'disabled';
  if (value === 'direct') return value;
  throw new ChequebookConfigurationError();
}

/** Runtime-only endpoint routing. Neither operation records nor API inputs may select URLs. */
export class ChequebookChainRegistry {
  #endpoints = new Map<number, string>();
  #createReader: (endpoint: string) => ChequebookChainReader;

  constructor(configuration: string | undefined, createReader: (endpoint: string) => ChequebookChainReader = endpoint => new ChainRpc(endpoint)) {
    this.#createReader = createReader;
    try {
      const configured: unknown = configuration ? JSON.parse(configuration) : {};
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new ChequebookConfigurationError();
      for (const [key, value] of Object.entries(configured)) {
        const chainId = Number(key);
        if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(chainId) || !tokenAddressForChain(chainId) || typeof value !== 'string') throw new ChequebookConfigurationError();
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new ChequebookConfigurationError();
        this.#endpoints.set(chainId, value);
      }
    } catch { throw new ChequebookConfigurationError(); }
  }

  async forChain(chainId: number, signal?: AbortSignal): Promise<ChequebookChainReader> {
    try {
      const endpoint = this.#endpoints.get(chainId);
      if (!endpoint || !tokenAddressForChain(chainId)) throw new ChainReadError();
      signal?.throwIfAborted();
      const reader = this.#createReader(endpoint);
      if (await reader.chainId(signal) !== chainId) throw new ChainReadError();
      signal?.throwIfAborted();
      return reader;
    } catch { throw new ChainReadError(); }
  }
}
