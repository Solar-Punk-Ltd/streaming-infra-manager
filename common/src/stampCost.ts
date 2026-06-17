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
