import { ChainReadError } from '../errors/ChainReadError.js';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { ChainRpc } from './ChainRpc.js';
import { tokenAddressForChain } from './transactionIdentity.js';

export type ChequebookChainReader = Pick<ChainRpc, 'chainId' | 'transactionCount' | 'transaction' | 'receipt' | 'blockHeader' | 'blockTransactions'>;
export type ChequebookEndpointMode = 'direct' | 'disabled';
/** Reads, again, the endpoint a saved transfer's node was started with. Null when it names none. */
export type ReadNodeChainEndpoint = (signal?: AbortSignal) => Promise<string | null>;

export function chequebookEndpointMode(value: string | undefined): ChequebookEndpointMode {
  if (value === undefined || value === '' || value === 'disabled') return 'disabled';
  if (value === 'direct') return value;
  throw new ChequebookConfigurationError();
}

/** An endpoint a transfer may read the chain through: http or https, a host, and no user information or fragment. */
function usableChainEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/**
 * Where a transfer reads the chain. CHEQUEBOOK_RPC_ENDPOINTS wins for every
 * chain it names. For any other chain the endpoint is the one the node being
 * funded was started with, read from its container's command on the Docker
 * connection the manager owns, and remembered for that node's saved transfers.
 *
 * So a deployment's saved chain endpoint, which a signed-in user sets through
 * the API, does choose where the manager itself sends a transfer's chain
 * reads, from the manager's own network: the node is started with it and the
 * manager reads it back from the node. A money request, an operation record
 * and a Bee answer never choose one. Both kinds of endpoint are held to the
 * same shape rules and must answer the node's chain before use, and no
 * endpoint is ever logged, answered or put in an error.
 */
export class ChequebookChainRegistry {
  #endpoints = new Map<number, string>();
  #nodeEndpoints = new Map<string, string>();
  #createReader: (endpoint: string) => ChequebookChainReader;

  constructor(configuration: string | undefined, createReader: (endpoint: string) => ChequebookChainReader = endpoint => new ChainRpc(endpoint)) {
    this.#createReader = createReader;
    try {
      const configured: unknown = configuration ? JSON.parse(configuration) : {};
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new ChequebookConfigurationError();
      for (const [key, value] of Object.entries(configured)) {
        const chainId = Number(key);
        if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(chainId) || !tokenAddressForChain(chainId) || !usableChainEndpoint(value)) {
          throw new ChequebookConfigurationError();
        }
        this.#endpoints.set(chainId, value);
      }
    } catch { throw new ChequebookConfigurationError('chain_setting_invalid'); }
  }

  /** The configured endpoint for a chain, and nothing else. */
  async forChain(chainId: number, signal?: AbortSignal): Promise<ChequebookChainReader> {
    try {
      if (!tokenAddressForChain(chainId)) throw new ChainReadError('unsupported_chain');
      const endpoint = this.#endpoints.get(chainId);
      if (!endpoint) throw new ChainReadError('chain_endpoint_missing');
      return await this.verified(endpoint, chainId, signal);
    } catch (error) { throw ChainReadError.keeping(error); }
  }

  /** A transfer being prepared: the configured endpoint, or else the one its node's container runs with now. */
  async forPreparedNode(chainId: number, nodeAddress: string, nodeEndpoint: string | null, signal?: AbortSignal): Promise<ChequebookChainReader> {
    if (this.#endpoints.has(chainId) || !tokenAddressForChain(chainId)) return this.forChain(chainId, signal);
    try {
      if (!usableChainEndpoint(nodeEndpoint)) throw new ChainReadError('chain_endpoint_missing');
      const reader = await this.verified(nodeEndpoint, chainId, signal);
      this.#nodeEndpoints.set(nodeKey(chainId, nodeAddress), nodeEndpoint);
      return reader;
    } catch (error) { throw ChainReadError.keeping(error); }
  }

  /**
   * A saved transfer's later reads: the configured endpoint, or else its node's.
   * A remembered endpoint that fails in any way sends the manager to read the
   * node once more, and what it reads replaces the remembered endpoint only
   * after it verified. Until then the remembered one is kept, and its failure is
   * what is reported when the node cannot be read, names nothing usable, or
   * names the same endpoint again, which is not tried a second time.
   */
  async forSavedNode(chainId: number, nodeAddress: string, readNodeEndpoint: ReadNodeChainEndpoint, signal?: AbortSignal): Promise<ChequebookChainReader> {
    if (this.#endpoints.has(chainId) || !tokenAddressForChain(chainId)) return this.forChain(chainId, signal);
    const key = nodeKey(chainId, nodeAddress);
    try {
      const remembered = this.#nodeEndpoints.get(key);
      let rememberedFailure: unknown = null;
      if (remembered) {
        try { return await this.verified(remembered, chainId, signal); }
        catch (error) { rememberedFailure = error; }
      }
      const unusable = (fallback: ChainReadError) => rememberedFailure ? ChainReadError.keeping(rememberedFailure) : fallback;
      let endpoint: string | null;
      try { endpoint = await readNodeEndpoint(signal); }
      catch (error) { throw unusable(ChainReadError.keeping(error, 'chain_endpoint_missing')); }
      if (!usableChainEndpoint(endpoint)) throw unusable(new ChainReadError('chain_endpoint_missing'));
      if (rememberedFailure && endpoint === remembered) throw ChainReadError.keeping(rememberedFailure);
      const reader = await this.verified(endpoint, chainId, signal);
      this.#nodeEndpoints.set(key, endpoint);
      return reader;
    } catch (error) { throw ChainReadError.keeping(error); }
  }

  /** A reader for the endpoint, once it answered the chain it is meant to read. */
  private async verified(endpoint: string, chainId: number, signal?: AbortSignal): Promise<ChequebookChainReader> {
    signal?.throwIfAborted();
    const reader = this.#createReader(endpoint);
    let answered: number;
    try { answered = await reader.chainId(signal); }
    catch { throw new ChainReadError('chain_unreachable'); }
    if (answered !== chainId) throw new ChainReadError('wrong_chain');
    signal?.throwIfAborted();
    return reader;
  }
}

function nodeKey(chainId: number, nodeAddress: string): string {
  return `${chainId}:${nodeAddress.toLowerCase()}`;
}
