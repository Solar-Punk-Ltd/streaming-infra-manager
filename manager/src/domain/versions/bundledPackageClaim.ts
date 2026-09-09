import { mkdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  validateBundledShipmentIdentity,
  verifyBundledPackage,
  type BundledShipmentIdentity,
  type VerifiedBundledPackage,
} from './bundledShipmentPackage.js';

export const BUNDLED_CLAIM_PAYLOAD = 'payload';

/**
 * Reserve a fresh owner directory before reading any payload. Rename into its
 * absent child cannot replace a previous claim. A failed verification leaves
 * the claimed files here for inspection, never ready for an implicit retry.
 */
export async function claimBundledPackage(
  readyPath: string,
  claimDirectory: string,
  expectedIdentity: BundledShipmentIdentity,
): Promise<VerifiedBundledPackage> {
  const expected = validateBundledShipmentIdentity(expectedIdentity);
  await mkdir(claimDirectory, { mode: 0o700 });
  const payload = join(claimDirectory, BUNDLED_CLAIM_PAYLOAD);
  try {
    await rename(readyPath, payload);
  } catch (error) {
    await rmdir(claimDirectory);
    throw error;
  }
  return verifyBundledPackage(payload, expected);
}
