import type {
  StackSettings,
  StackSettingsApplied,
  StackSettingsFileEdit,
  StackSettingsSaved,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

/**
 * The host-owned settings of one version.
 *
 * The values come back in the clear, secrets included, because the page is
 * behind the session gate and a value the operator cannot see is one they
 * cannot check. Nothing here ever writes a value to the console.
 */

export function fetchVersionSettings(id: number): Promise<StackSettings> {
  return getJson<StackSettings>(`/versions/${id}/settings`, { cache: 'no-store' });
}

export function saveVersionSettings(
  id: number,
  expectedGeneration: number,
  files: StackSettingsFileEdit[],
): Promise<StackSettingsSaved> {
  return sendJson<StackSettingsSaved>('PUT', `/versions/${id}/settings`, {
    expectedGeneration,
    files,
  });
}

/** Publishes another build of the same commit with the settings as they stand. */
export function applyVersionSettings(id: number): Promise<StackSettingsApplied> {
  return sendJson<StackSettingsApplied>('POST', `/versions/${id}/settings/apply`);
}
