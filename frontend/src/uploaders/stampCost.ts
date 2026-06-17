const BLOCK_TIME_SECONDS = 5n;

function toPositiveBigInt(value: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

export function stampTtlSeconds(
  amount: string,
  currentPrice: string | null | undefined,
): number | null {
  const amountBn = toPositiveBigInt(amount);
  const priceBn = currentPrice != null ? toPositiveBigInt(currentPrice) : null;
  if (amountBn == null || priceBn == null) return null;
  return Number((amountBn / priceBn) * BLOCK_TIME_SECONDS);
}

export function stampCostPlur(
  amount: string,
  depth: number | null | undefined,
): string | null {
  const amountBn = toPositiveBigInt(amount);
  if (
    amountBn == null ||
    depth == null ||
    !Number.isInteger(depth) ||
    depth < 0
  ) {
    return null;
  }
  return (amountBn * (1n << BigInt(depth))).toString();
}
