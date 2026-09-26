import { BEE_BRIDGE_BINARIES, type BeeBridgeBinaryCheck } from '@streaming-infra-manager/common';
import { BEE_BRIDGE_CHECK_MARK } from '../../src/domain/chequebook/beeBridgeCheck.js';

/** What the check's shell prints in an image with the given paths missing and the given /dev/tcp answer. */
export function syntheticBeeBridgeCheckAnswer(options: { missing?: readonly BeeBridgeBinaryCheck[]; devTcp?: 'refused' | 'missing' | 'unexpected' } = {}): string {
  const missing = new Set(options.missing ?? []);
  const lines = Object.entries(BEE_BRIDGE_BINARIES).map(([check, path]) =>
    `${BEE_BRIDGE_CHECK_MARK} binary ${path} ${missing.has(check as BeeBridgeBinaryCheck) ? 'missing' : 'present'}`);
  if (!missing.has('bash')) lines.push(`${BEE_BRIDGE_CHECK_MARK} dev_tcp ${options.devTcp ?? 'refused'}`);
  lines.push(`${BEE_BRIDGE_CHECK_MARK} done`);
  return `${lines.join('\n')}\n`;
}
