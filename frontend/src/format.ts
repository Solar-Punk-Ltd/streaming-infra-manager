const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Shown where a number is not known. Never an em dash, which reads as prose. */
export const NO_VALUE = '–';

/** 1610612736 → "1.5 GB". null/undefined → the no-value dash. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return NO_VALUE;
  if (bytes < 1) return '0 B';
  const exp = Math.min(
    UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return NO_VALUE;
  return `${formatBytes(bytesPerSec)}/s`;
}

/** BZZ is quoted in PLUR. */
export const BZZ_DECIMALS = 16;
/** xDAI is an ordinary 18-decimal native token. */
export const XDAI_DECIMALS = 18;

/**
 * Format a base-unit integer string (e.g. wei) to a decimal token amount.
 * Uses BigInt to avoid precision loss. xDAI has 18 decimals, BZZ (PLUR) has 16.
 */
export function formatTokenBalance(
  raw: string | null | undefined,
  decimals: number,
  fractionDigits = 4,
): string {
  if (raw == null || raw === '') return NO_VALUE;
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
  if (seconds == null || !Number.isFinite(seconds)) return NO_VALUE;
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
  if (cpuPercent == null || !Number.isFinite(cpuPercent)) return NO_VALUE;
  return (cpuPercent / 100).toFixed(2);
}

export function formatPercent(
  percent: number | null | undefined,
  digits = 0,
): string {
  if (percent == null || !Number.isFinite(percent)) return NO_VALUE;
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
    return NO_VALUE;
  }
  const pct = (used / total) * 100;
  if (!Number.isFinite(pct)) return NO_VALUE;
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}%`;
}

/** "3 Sep 2026". Dates are read, not sorted, everywhere they appear here. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Date and clock time, for the moment something failed. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  return date.toLocaleString('en-GB');
}

/** A long hex value elided in the middle: batch ids, addresses, tx hashes. */
export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}
