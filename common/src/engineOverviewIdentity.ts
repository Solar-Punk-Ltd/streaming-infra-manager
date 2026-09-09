import type { EngineSettings } from './engineSettings.js';
import { engineOfServices, type EngineName } from './engines.js';
import { defaultServicesFor, hasBeePublishers, type StampGatedProfile } from './stampGating.js';

export interface EngineOverviewIdentityInput extends StampGatedProfile {
  name: string;
  instance_id: string;
  engine_config_revision: string | number | bigint;
  intent_revision: string | number | bigint;
  updated_at: string | Date;
  stack_version_id: number;
  has_engine_config: boolean;
  engine_settings: EngineSettings;
}

/** Identifies the database input, not an observation of the running engine. */
export interface EngineOverviewIdentity {
  name: string;
  instanceId: string;
  configRevision: string;
  intentRevision: string;
  updatedAt: string;
  stackVersionId: number;
  hasConfig: boolean;
  engine: EngineName;
  abr: boolean;
  settingsKey: string;
}

function revisionText(value: string | number | bigint): string {
  if ((typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
    || !/^\d+$/.test(String(value))) throw new Error('Engine observation revision is invalid.');
  return BigInt(value).toString();
}

/** The same canonical input on either side of HTTP produces the same identity. */
export function engineOverviewIdentity(profile: EngineOverviewIdentityInput): EngineOverviewIdentity {
  const engine = engineOfServices(defaultServicesFor(profile));
  if (!engine || !profile.name || !profile.instance_id) throw new Error('Engine observation identity is unavailable.');
  const settings = Object.entries(profile.engine_settings)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return {
    name: profile.name,
    instanceId: profile.instance_id,
    configRevision: revisionText(profile.engine_config_revision),
    intentRevision: revisionText(profile.intent_revision),
    updatedAt: new Date(profile.updated_at).toISOString(),
    stackVersionId: profile.stack_version_id,
    hasConfig: profile.has_engine_config,
    engine,
    abr: hasBeePublishers(profile),
    settingsKey: JSON.stringify(settings),
  };
}

/** Explicit field order also handles an HTTP object's different property order. */
export function engineOverviewIdentityKey(identity: EngineOverviewIdentity): string {
  return JSON.stringify([
    identity.name, identity.instanceId, identity.configRevision, identity.intentRevision, identity.updatedAt,
    identity.stackVersionId, identity.hasConfig, identity.engine, identity.abr, identity.settingsKey,
  ]);
}
