import {
  configuredBeeRpcEndpoint,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  type DeploymentSettingSource,
  type DeploymentSettingsDrift,
  type EngineName,
  isSecretSettingKey,
  type SettingRunningState,
  type StackContract,
  stackSettingFieldOf,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import { parseEnvText } from '../../utils/envUtils.js';
import type { ContainerRow } from '../ContainerRepository.js';
import { SERVICE_ENV_KEYS } from '../containerKeysSpec.js';
import { sampleCatalogOf, type SampleCatalogEntry } from '../versions/envSettingsText.js';
import { portTableOf } from '../versions/portTable.js';

import { isChainEndpointKey, recordedStateOf } from './runningRecord.js';
import { settingOwnerOf } from './settingOwners.js';

/** Everything a deployment's settings list is worked out from, read by the caller. */
export interface CatalogInput {
  profile: Profile;
  engine: EngineName;
  contract: StackContract | null | undefined;
  /** The build of the version the next deploy uses. */
  buildId: string | null;
  /** The build's `.env.sample` and its engine's, for the keys, their sections and descriptions. */
  rootSampleText: string;
  engineSampleText: string;
  /** The build's `.env` and its engine's, for what the version sets. */
  baseEnvText: string;
  engineEnvText: string;
  /** What the deployment stores: plain values, and the names of the secret ones. */
  stored: { plain: Readonly<Record<string, string>>; secretKeys: readonly string[] };
  revision: number;
  /** The environment the next deploy gives the containers, as `effectiveEnvOf` works it out. */
  nextEnv: Readonly<Record<string, string>>;
  /** What each container was started with, one record per deployed service. */
  records: readonly ContainerRow[];
  /** Keys whose next value is a secret the manager generated for this deployment. */
  generatedKeys: readonly string[];
  isLocalTarget: boolean;
}

/** The statuses whose containers run, so Apply means something. */
const RUNNING_STATUSES: readonly string[] = ['RUNNING', 'ERROR'];

/** A deployment's settings as its page lists them. */
export function deploymentSettingsCatalogOf(input: CatalogInput): DeploymentSettingsCatalog {
  const running = RUNNING_STATUSES.includes(input.profile.status);
  const readers = readersByKey(input.contract);
  const version = { ...parseEnvText(input.engineEnvText), ...parseEnvText(input.baseEnvText) };
  const ownerContext = {
    ports: [...portTableOf(input.contract), ...(input.contract?.portAliases ?? [])],
    isLocalTarget: input.isLocalTarget,
  };

  const entries = declaredKeysOf(input).map((declared) => {
    const key = declared.key;
    const secret = isSecretSettingKey(key);
    const services = readers.get(key) ?? null;
    const differing = differingServices(key, services, input);
    return {
      entry: {
        key,
        section: declared.section,
        description: declared.description,
        secret,
        sampleValue: declared.value ?? declared.example,
        versionSet: key in version,
        versionValue: secret || !(key in version) ? null : shown(key, version[key]!),
        stored: key in input.stored.plain || input.stored.secretKeys.includes(key),
        storedValue: secret ? null : (input.stored.plain[key] ?? null),
        value: secret || !(key in input.nextEnv) ? null : shown(key, input.nextEnv[key]!),
        source: sourceOf(key, input, settingOwnerOf(key, ownerContext) !== null),
        owner: settingOwnerOf(key, ownerContext),
        field: stackSettingFieldOf(key),
        services,
        running: runningStateOf(running, differing),
      } satisfies DeploymentSettingEntry,
      differing: differing === 'unknown' ? [] : differing,
    };
  });

  return {
    instanceId: input.profile.instance_id,
    revision: input.revision,
    buildId: input.buildId,
    entries: entries.map(({ entry }) => entry),
    drift: driftOf(entries),
    running,
  };
}

/**
 * The root sample's keys, then the engine's the root does not declare, then
 * the keys the deployment stores that neither declares any more.
 */
function declaredKeysOf(input: CatalogInput): SampleCatalogEntry[] {
  const declared = new Map<string, SampleCatalogEntry>();
  for (const entry of [...sampleCatalogOf(input.rootSampleText), ...sampleCatalogOf(input.engineSampleText)]) {
    if (!declared.has(entry.key)) declared.set(entry.key, entry);
  }
  for (const key of [...Object.keys(input.stored.plain), ...input.stored.secretKeys]) {
    if (!declared.has(key)) declared.set(key, { key, section: '', description: '', value: null, example: null });
  }
  return [...declared.values()];
}

/** The services whose containers read each key, from the contract or, for an older one, the manager's own list. */
function readersByKey(contract: StackContract | null | undefined): Map<string, string[]> {
  const byService = contract?.serviceEnvKeys ?? SERVICE_ENV_KEYS;
  const readers = new Map<string, string[]>();
  for (const [service, keys] of Object.entries(byService)) {
    for (const key of keys) readers.set(key, [...(readers.get(key) ?? []), service]);
  }
  return readers;
}

function sourceOf(key: string, input: CatalogInput, owned: boolean): DeploymentSettingSource {
  if (owned) return 'manager';
  if (key in input.stored.plain || input.stored.secretKeys.includes(key)) return 'deployment';
  if (input.generatedKeys.includes(key)) return 'generated';
  return key in input.nextEnv ? 'version' : 'unset';
}

/** A value as the page may show it: a chain endpoint by its host, which carries no key. */
function shown(key: string, value: string): string {
  if (!isChainEndpointKey(key) || value === '') return value;
  const { host } = configuredBeeRpcEndpoint(value);
  return host ? `<${host}>` : '<redacted>';
}

/**
 * The services whose running container got another value for this key than
 * the next deploy writes, or `unknown` when no record says. A key no
 * container's block reads reached the deploy scripts alone, and every record
 * covers it, because it decided how each container of that deploy started.
 */
function differingServices(
  key: string,
  services: readonly string[] | null,
  input: CatalogInput,
): string[] | 'unknown' {
  const records = services === null ? input.records : input.records.filter((record) => services.includes(record.service));
  const states = records.map((record) => ({ service: record.service, state: recordedStateOf(record, key, input.nextEnv[key]) }));
  const known = states.filter(({ state }) => state !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.filter(({ state }) => state === 'differs').map(({ service }) => service);
}

function runningStateOf(running: boolean, differing: string[] | 'unknown'): SettingRunningState {
  if (!running) return 'not-running';
  if (differing === 'unknown') return 'unknown';
  return differing.length > 0 ? 'differs' : 'same';
}

function driftOf(entries: readonly { entry: DeploymentSettingEntry; differing: string[] }[]): DeploymentSettingsDrift {
  const behind = entries.filter(({ differing }) => differing.length > 0);
  return {
    keys: behind.map(({ entry }) => entry.key),
    services: [...new Set(behind.flatMap(({ differing }) => differing))].sort(),
    fullRedeploy: behind.some(({ entry }) => entry.services === null),
  };
}
