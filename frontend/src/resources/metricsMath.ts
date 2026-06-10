export function fractionOf(
  used: number | null | undefined,
  total: number | null | undefined,
): number {
  if (used == null || total == null || total <= 0) return 0;
  return used / total;
}

export function cpuFractionOfHost(
  cpuCorePercent: number,
  ncpu: number,
): number {
  return ncpu > 0 ? cpuCorePercent / 100 / ncpu : 0;
}

export function coresFromCorePercent(cpuCorePercent: number): number {
  return cpuCorePercent / 100;
}
