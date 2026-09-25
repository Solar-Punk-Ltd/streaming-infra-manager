import {
  type BeeStampTransaction,
  minimumStampAmountPlur,
  parsePlur,
  plurToBzzExact,
  topUpPreview,
} from '@streaming-infra-manager/common';

import { formatTtl, NO_VALUE, shortHex } from '../format';
import type { BeeStamp } from './stampApi';

const WHOLE_PLUR = /^[1-9][0-9]*$/;

export interface TopUpInput {
  stamp: BeeStamp;
  /** The amount as typed, PLUR per chunk. */
  amount: string;
  /** Today's price per chunk per block, null where the node did not say. */
  currentPrice: string | null;
  /** What the node's wallet holds in PLUR, null where it was not read. */
  walletBzz: string | null | undefined;
}

export interface TopUpView {
  amountValid: boolean;
  amountHint: string;
  /** The life the amount adds at today's price. */
  addsLife: string;
  /** The life the batch has after it. */
  lifeAfter: string;
  /** What it takes from the node's wallet, "1.5 BZZ". */
  cost: string;
  /** Why the wallet cannot pay it, where it was read and cannot. */
  shortfall: string | null;
  confirmLabel: string;
  canConfirm: boolean;
}

/**
 * What the top-up dialog shows for an amount before the operator pays: what it
 * adds and costs, worked out by `topUpPreview`, and whether it can be confirmed.
 *
 * The cost is written out exactly, every digit, because it is money leaving the
 * node's wallet and a rounded figure would name a different amount.
 */
export function topUpView({ stamp, amount, currentPrice, walletBzz }: TopUpInput): TopUpView {
  const typed = amount.trim();
  const amountValid = WHOLE_PLUR.test(typed);
  const preview = topUpPreview(stamp, typed, currentPrice);
  const costPlur = amountValid ? parsePlur(preview.costPlur) : null;
  const shortfall = walletShortfall(parsePlur(walletBzz), costPlur);
  return {
    amountValid,
    amountHint: amountHint(typed, amountValid, currentPrice),
    addsLife: addedLifeText(preview.addedTtl),
    lifeAfter: formatTtl(preview.ttl),
    cost: costPlur === null ? NO_VALUE : `${plurToBzzExact(costPlur)} BZZ`,
    shortfall,
    confirmLabel: costPlur === null ? 'Top up' : `Top up for ${plurToBzzExact(costPlur)} BZZ`,
    canConfirm: costPlur !== null && shortfall === null,
  };
}

/** What the Storage card says once bee has answered a top-up. */
export function topUpSentNotice(stamp: BeeStamp, sent: BeeStampTransaction): string {
  return `Bee sent the top-up of batch ${shortHex(stamp.batchID)} in transaction ${shortHex(sent.txHash)}, which is mined. The new life shows here once the node has read it back from the chain, usually within a minute.`;
}

function amountHint(typed: string, amountValid: boolean, currentPrice: string | null): string {
  if (typed !== '' && !amountValid) return 'A whole number of PLUR above zero.';
  const oneDay = minimumStampAmountPlur(currentPrice);
  return oneDay === null
    ? 'PLUR per chunk. The price is not known yet, so neither is the life it adds.'
    : `PLUR per chunk. A day more costs ${oneDay} a chunk at today’s price.`;
}

/** An amount too small to buy a single block reads as nothing added, never as expired. */
function addedLifeText(seconds: number | null): string {
  if (seconds === null) return NO_VALUE;
  return seconds === 0 ? formatTtl(1) : formatTtl(seconds);
}

function walletShortfall(wallet: bigint | null, cost: bigint | null): string | null {
  if (wallet === null || cost === null || wallet >= cost) return null;
  return `This node’s wallet holds ${plurToBzzExact(wallet)} BZZ, less than the ${plurToBzzExact(cost)} BZZ this top-up costs. Send BZZ to its address first.`;
}
