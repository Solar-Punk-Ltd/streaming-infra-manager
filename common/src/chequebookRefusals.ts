import type { TransferDirection } from './chequebook.js';

/**
 * Why the manager refused to prepare a chequebook transfer. The manager sets
 * one where it decides to refuse, and answers it with the 503. Nothing in
 * this list is ever filled from upstream text.
 */
export const CHEQUEBOOK_REFUSAL_CAUSES = [
  'docker_unreachable',
  'docker_route_missing',
  'docker_setting_invalid',
  'bee_container_not_found',
  'bee_container_unsupported',
  'bridge_not_qualified',
  'chain_endpoint_missing',
  'chain_setting_invalid',
  'chain_unreachable',
  'wrong_chain',
  'unsupported_chain',
  'target_changed',
  'bee_unreadable',
  'unavailable',
] as const;
export type ChequebookRefusalCause = (typeof CHEQUEBOOK_REFUSAL_CAUSES)[number];

/**
 * The absolute paths the transfer bridge script runs, each checked in a Bee
 * image before money moves through it.
 */
export const BEE_BRIDGE_BINARIES = Object.freeze({
  env: '/usr/bin/env',
  timeout: '/usr/bin/timeout',
  bash: '/bin/bash',
  cat: '/usr/bin/cat',
} as const);

export type BeeBridgeBinaryCheck = keyof typeof BEE_BRIDGE_BINARIES;

/** Every check the manager runs against a Bee image, the four paths above, bash's /dev/tcp, and a readable answer. */
export const BEE_BRIDGE_CHECKS = ['env', 'timeout', 'bash', 'cat', 'dev_tcp', 'answer'] as const satisfies readonly (BeeBridgeBinaryCheck | 'dev_tcp' | 'answer')[];
export type BeeBridgeCheck = (typeof BEE_BRIDGE_CHECKS)[number];

export interface ChequebookRefusal {
  readonly cause: ChequebookRefusalCause;
  /** The bridge check that failed. Only a bridge that was not qualified carries one, and null there means pinned ids matched nothing. */
  readonly check: BeeBridgeCheck | null;
}

export function chequebookRefusal(cause: ChequebookRefusalCause, check: BeeBridgeCheck | null = null): ChequebookRefusal {
  const refusal = { cause, check };
  if (!isChequebookRefusal(refusal)) throw new Error('Not a chequebook refusal.');
  return Object.freeze(refusal);
}

export function isChequebookRefusal(value: unknown): value is ChequebookRefusal {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'cause,check') return false;
  const { cause, check } = value as Record<string, unknown>;
  if (!(CHEQUEBOOK_REFUSAL_CAUSES as readonly unknown[]).includes(cause)) return false;
  if (check === null) return true;
  return cause === 'bridge_not_qualified' && (BEE_BRIDGE_CHECKS as readonly unknown[]).includes(check);
}

const NOTHING_SENT = 'Nothing was sent.';

const CAUSE_SENTENCES: Readonly<Record<Exclude<ChequebookRefusalCause, 'bridge_not_qualified'>, string>> = Object.freeze({
  docker_unreachable: 'The manager could not reach Docker on this deployment\'s host. Check that Docker runs there and that the manager can reach it, over ssh for a remote host, then try again.',
  docker_route_missing: 'The manager has no Docker connection it can use for this deployment\'s host. Give a remote host its own Host block in the manager\'s ssh_config and deploy under that alias, or name the host in CHEQUEBOOK_DOCKER_TRANSPORTS.',
  docker_setting_invalid: 'The manager\'s CHEQUEBOOK_DOCKER_TRANSPORTS setting is malformed or names a qualification id that does not exist. Correct it or remove it, then restart the manager.',
  bee_container_not_found: 'The deployment\'s Bee container is not running on its host. Start the deployment, then try again.',
  bee_container_unsupported: 'The deployment\'s Bee container is not set up the way a transfer needs. It must publish its API on the port the manager reserved and must not use the host\'s network. Deploy it again from the manager, then try again.',
  chain_endpoint_missing: 'The deployment\'s Bee node was started without a usable chain endpoint, and CHEQUEBOOK_RPC_ENDPOINTS names none for its chain. Give the deployment a chain endpoint and deploy it again, or set CHEQUEBOOK_RPC_ENDPOINTS.',
  chain_setting_invalid: 'The manager\'s CHEQUEBOOK_RPC_ENDPOINTS setting is malformed. Correct it or remove it, then restart the manager.',
  chain_unreachable: 'The chain endpoint did not answer the manager. Check that the endpoint the Bee node uses can be reached from the manager, or set CHEQUEBOOK_RPC_ENDPOINTS, then try again.',
  wrong_chain: 'The chain endpoint answered for a different chain than the Bee node runs on. Point the node, or CHEQUEBOOK_RPC_ENDPOINTS, at an endpoint of the node\'s own chain.',
  unsupported_chain: 'The deployment\'s Bee node runs on a chain whose BZZ token this manager does not know. Transfers work on Gnosis Chain, Ethereum and Sepolia.',
  target_changed: 'The deployment or its host\'s Docker changed while the transfer was being prepared, or the deployment is being deployed, stopped or removed. Wait until it is running and settled, or deploy it again, then try again.',
  bee_unreadable: 'The deployment\'s Bee node did not answer, or answered inconsistently. Check that the node is running and synced, then try again.',
  unavailable: 'The node and chain could not be checked. Refresh the saved transfers before continuing.',
});

const CHECK_SENTENCES: Readonly<Record<'pinned' | 'dev_tcp' | 'answer', string>> = Object.freeze({
  pinned: 'CHEQUEBOOK_DOCKER_TRANSPORTS pins qualification ids for this host, and none of them matches the Bee image and Docker engine it runs. Remove the ids to let the manager check the image itself, then restart the manager.',
  dev_tcp: 'The Bee image on this host has a bash without /dev/tcp, which the transfer bridge is built on. Run a Bee image whose bash has it, then try again.',
  answer: 'The check of this host\'s Bee image gave no answer the manager could read, so the transfer bridge was not used. Check that the Bee container runs normally, then try again.',
});

function bridgeSentence(check: BeeBridgeCheck | null): string {
  if (check === null) return CHECK_SENTENCES.pinned;
  if (check === 'dev_tcp' || check === 'answer') return CHECK_SENTENCES[check];
  return `The Bee image on this host has no ${BEE_BRIDGE_BINARIES[check]}, which the transfer bridge needs. Run a Bee image that has it, then try again.`;
}

/** One plain sentence per refusal: what is wrong and what to do about it. */
export function chequebookRefusalSentence(refusal: ChequebookRefusal): string {
  const sentence = refusal.cause === 'bridge_not_qualified' ? bridgeSentence(refusal.check) : CAUSE_SENTENCES[refusal.cause];
  return `${sentence} ${NOTHING_SENT}`;
}

/** Why the manager's last check before sending refused a transfer it had already recorded. */
export const CHEQUEBOOK_PREFLIGHT_REFUSALS = ['preflight_failed', 'preflight_no_gas', 'preflight_insufficient_balance'] as const;
export type ChequebookPreflightRefusal = (typeof CHEQUEBOOK_PREFLIGHT_REFUSALS)[number];

export function isChequebookPreflightRefusal(value: unknown): value is ChequebookPreflightRefusal {
  return (CHEQUEBOOK_PREFLIGHT_REFUSALS as readonly unknown[]).includes(value);
}

export function chequebookPreflightSentence(reason: ChequebookPreflightRefusal, direction: TransferDirection): string {
  if (reason === 'preflight_no_gas') {
    return 'The node\'s wallet has no xDAI to pay gas with, so the manager refused this transfer before sending it. Send xDAI to the node\'s wallet, then start a new transfer.';
  }
  if (reason === 'preflight_insufficient_balance') {
    return direction === 'deposit'
      ? 'The node\'s wallet holds less BZZ than this transfer asks for, so the manager refused it before sending it. Lower the amount or add BZZ to the wallet, then start a new transfer.'
      : 'The chequebook has less available BZZ than this withdrawal asks for, so the manager refused it before sending it. Lower the amount, then start a new transfer.';
  }
  return 'The manager\'s last check refused this transfer before it was sent. Start a new transfer once the node and the deployment are settled.';
}
