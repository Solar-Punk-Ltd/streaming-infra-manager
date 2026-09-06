import type {
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
