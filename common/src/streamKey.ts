import { privateKeyToAddress } from 'viem/accounts';

const STREAM_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The address a stream key signs its feeds as, which is the feed owner the
 * web2 admin must name, or null when the value is not a key. It runs in memory
 * and keeps nothing, and a key it refuses never reaches an error.
 */
export function addressOfStreamKey(streamKey: string): string | null {
  const key = streamKey.trim();
  if (!STREAM_KEY_RE.test(key)) return null;
  try {
    return privateKeyToAddress(key as `0x${string}`);
  } catch {
    return null;
  }
}
