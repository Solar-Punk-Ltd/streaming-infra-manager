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

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Format a base-unit integer string (e.g. wei) to a decimal token amount.
 * Uses BigInt to avoid precision loss. xDAI: decimals=18; BZZ (PLUR): 16.
 */
export function formatTokenBalance(
  raw: string | null | undefined,
  decimals: number,
  fractionDigits = 4,
): string {
  if (raw == null || raw === '') return '—';
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return raw;
  }
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rem = value % base;
  const scaled = (rem * 10n ** BigInt(fractionDigits)) / base;
  const frac = scaled.toString().padStart(fractionDigits, '0');
  return `${whole.toString()}.${frac}`;
}

export function formatTtl(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 0) return 'unknown';
  if (seconds === 0) return 'expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatCores(cpuPercent: number | null | undefined): string {
  if (cpuPercent == null || !Number.isFinite(cpuPercent)) return '—';
  return (cpuPercent / 100).toFixed(2);
}

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
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return '—';
  }
  const pct = (used / total) * 100;
  if (!Number.isFinite(pct)) return '—';
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}%`;
}
