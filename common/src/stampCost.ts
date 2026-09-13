export const BLOCK_TIME_SECONDS = 5n;

const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);

function parsePositiveBigInt(value: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

export function stampTtlSeconds(
  amountPerChunkPlur: string,
  pricePerBlockPlur: string | null | undefined,
): number | null {
  const amountPerChunk = parsePositiveBigInt(amountPerChunkPlur);
  const pricePerBlock =
    pricePerBlockPlur != null ? parsePositiveBigInt(pricePerBlockPlur) : null;
  if (amountPerChunk == null || pricePerBlock == null || pricePerBlock <= 0n) {
    return null;
  }

  const lifetimeSeconds = (amountPerChunk * BLOCK_TIME_SECONDS) / pricePerBlock;
  if (lifetimeSeconds > MAX_SAFE_INTEGER_BIG) return null;
  return Number(lifetimeSeconds);
}

export function stampCostPlur(
  amountPerChunkPlur: string,
  depth: number | null | undefined,
): string | null {
  const amountPerChunk = parsePositiveBigInt(amountPerChunkPlur);
  if (
    amountPerChunk == null ||
    depth == null ||
    !Number.isInteger(depth) ||
    depth < 0
  ) {
    return null;
  }

  const chunkCount = 1n << BigInt(depth);
  return (amountPerChunk * chunkCount).toString();
}

/** Bee refuses a batch that would not outlive this, whatever the operator asks for. */
export const MINIMUM_STAMP_VALIDITY_SECONDS = 24n * 60n * 60n;

/**
 * The smallest per-chunk amount this node will accept right now, or null when
 * the price is not known yet.
 *
 * Bee answers a smaller one with a plain 400 and buys nothing. On the live host
 * on 2026-09-13 the form offered 500,000,000 as eight hours of life, the node
 * refused it as "insufficient initial balance for 24h minimum validity", and
 * the operator had no way to know the floor was 1,571,927,040 that minute. The
 * floor moves with the chain price, so it has to be worked out rather than
 * written down.
 */
export function minimumStampAmountPlur(
  pricePerBlockPlur: string | null | undefined,
): string | null {
  const pricePerBlock =
    pricePerBlockPlur != null ? parsePositiveBigInt(pricePerBlockPlur) : null;
  if (pricePerBlock == null || pricePerBlock <= 0n) return null;
  return String((MINIMUM_STAMP_VALIDITY_SECONDS * pricePerBlock) / BLOCK_TIME_SECONDS);
}
