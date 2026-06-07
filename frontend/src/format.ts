/** Human-readable formatting for resource metrics. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1610612736 → "1.5 GB". null/undefined → "—". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1) return '0 B';
  const exp = Math.min(
    UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}

/** bytes-per-second → "1.5 MB/s". */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** CPU percent (share-of-one-core × 100) → cores, e.g. 250 → "2.50". */
export function formatCores(cpuPercent: number | null | undefined): string {
  if (cpuPercent == null || !Number.isFinite(cpuPercent)) return '—';
  return (cpuPercent / 100).toFixed(2);
}

/** 37.236 → "37%". null → "—". */
export function formatPercent(
  percent: number | null | undefined,
  digits = 0,
): string {
  if (percent == null || !Number.isFinite(percent)) return '—';
  return `${percent.toFixed(digits)}%`;
}

/**
 * `used / total` as a percentage, with decimals scaled to the magnitude so
 * tiny shares stay legible (0.04%) while big ones stay clean (37%).
 */
export function formatSharePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): string {
  if (used == null || total == null || !Number.isFinite(used) || !total) {
    return '—';
  }
  const pct = (used / total) * 100;
  if (!Number.isFinite(pct)) return '—';
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}%`;
}
