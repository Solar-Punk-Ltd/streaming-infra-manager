import type {
  EngineConfigView,
  EngineOverview,
  EngineSettings,
} from '@streaming-infra-manager/common';

import { apiFetch, failWith, getJson, sendJson } from '../http';
import type { Profile } from '../types';

// Declared where the manager and the offline mock read it from, so the three
// cannot drift apart over what this route answers.
export type { EngineOverview };

export function fetchEngine(name: string): Promise<EngineOverview> {
  return getJson<EngineOverview>(
    `/profiles/${encodeURIComponent(name)}/engine`,
  );
}

/** Stores the settings and recreates the engine container with them. */
export function saveEngineSettings(
  name: string,
  settings: EngineSettings,
): Promise<Profile> {
  return sendJson<Profile>(
    'PUT',
    `/profiles/${encodeURIComponent(name)}/engine-settings`,
    settings,
  );
}

export function restartContainer(
  name: string,
  service: string,
): Promise<void> {
  return sendJson<void>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/containers/${encodeURIComponent(service)}/restart`,
    {},
  );
}

/** Both routes below answer text, so they read the body rather than parse it. */
async function getText(path: string): Promise<string> {
  const res = await apiFetch(path);
  if (!res.ok) await failWith(res, `request failed (${res.status})`);
  return res.text();
}

export function fetchContainerLogs(
  name: string,
  service: string,
  tail: number,
): Promise<string> {
  return getText(
    `/profiles/${encodeURIComponent(name)}/containers/${encodeURIComponent(service)}/logs?tail=${tail}`,
  );
}

/** The config the engine generated at startup, as it is running it. */
export function fetchEngineConfig(name: string): Promise<string> {
  return getText(`/profiles/${encodeURIComponent(name)}/engine/config`);
}

/** What the config file editor opens on: the stored file or the version's template. */
export function fetchEngineConfigView(name: string): Promise<EngineConfigView> {
  return getJson<EngineConfigView>(
    `/profiles/${encodeURIComponent(name)}/engine-config`,
  );
}

/** Checks the file, stores it and recreates the engine on it. */
export function saveEngineConfig(name: string, config: string): Promise<Profile> {
  return sendJson<Profile>(
    'PUT',
    `/profiles/${encodeURIComponent(name)}/engine-config`,
    { config },
  );
}

/** Forgets the file and recreates the engine on the version's template. */
export function resetEngineConfig(name: string): Promise<Profile> {
  return sendJson<Profile>(
    'DELETE',
    `/profiles/${encodeURIComponent(name)}/engine-config`,
    {},
  );
}

/** Recreates the engine on what is stored, file or template, and verifies it again. */
export function verifyEngineConfig(name: string): Promise<Profile> {
  return sendJson<Profile>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/engine-config/verify`,
    {},
  );
}

/** Puts the file an interrupted rollout replaced back and recreates the engine on it. */
export function restorePreviousEngineConfig(name: string): Promise<Profile> {
  return sendJson<Profile>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/engine-config/restore-previous`,
    {},
  );
}
