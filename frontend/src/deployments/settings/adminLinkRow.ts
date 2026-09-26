import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  type DeploymentSettingEdit,
  type DeploymentSettingEntry,
} from '@streaming-infra-manager/common';

import { takesValue } from './deploymentSettingsDraft';

const ADMIN_KEYS: readonly string[] = [ADMIN_API_URL_KEY, ADMIN_API_TOKEN_KEY];

/**
 * The key a deployment's Stack settings card shows Test connection after:
 * the later of the two web2 admin keys the operator sets here, in the list's
 * order, or null for a version that gives the operator no address to set.
 */
export function adminLinkTestAnchor(entries: readonly DeploymentSettingEntry[]): string | null {
  const settable = entries.filter((entry) => ADMIN_KEYS.includes(entry.key) && takesValue(entry));
  if (!settable.some((entry) => entry.key === ADMIN_API_URL_KEY)) return null;
  return settable.at(-1)?.key ?? null;
}

/** What the card's test says while either key holds a change that is not saved, which the test does not use. */
export function unsavedAdminLinkNote(pending: readonly DeploymentSettingEdit[]): string | null {
  return pending.some(({ key }) => ADMIN_KEYS.includes(key))
    ? 'The test uses what is saved, not the changes above that are not saved yet.'
    : null;
}
