import {
  configuredBeeRpcEndpoint,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  type DeploymentSettingSource,
  type DeploymentSettingsDrift,
  type EngineName,
  isSecretSettingKey,
  type NewDeploymentSettingsCatalog,
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
import { type SettingOwnerContext, settingOwnerOf } from './settingOwners.js';

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

/**
 * What a deployment that does not exist yet is listed from: the version's side
 * of `CatalogInput`, and whether it would run on the manager's own host.
 */
export type NewDeploymentCatalogInput = Pick<
  CatalogInput,
  'contract' | 'buildId' | 'rootSampleText' | 'engineSampleText' | 'baseEnvText' | 'engineEnvText' | 'isLocalTarget'
> & {
  versionId: number;
  /** Keys the manager generates a secret for at the first deploy, because the version supplies none. */
  generatedKeys: readonly string[];
};

/** What one list is worked out from, whether the deployment exists or not. */
type ListInput = Omit<CatalogInput, 'profile' | 'engine' | 'buildId' | 'revision'>;

/** One key as the list answers it, with the services whose running container got another value. */
interface ListedSetting {
  entry: DeploymentSettingEntry;
  differing: string[];
}

/** The statuses whose containers run, so Apply means something. */
const RUNNING_STATUSES: readonly string[] = ['RUNNING', 'ERROR'];

const NOTHING_STORED: CatalogInput['stored'] = { plain: {}, secretKeys: [] };

/** A deployment's settings as its page lists them. */
export function deploymentSettingsCatalogOf(input: CatalogInput): DeploymentSettingsCatalog {
  const running = RUNNING_STATUSES.includes(input.profile.status);
  const listed = listedSettingsOf(input, running);
  return {
    instanceId: input.profile.instance_id,
    revision: input.revision,
    buildId: input.buildId,
    entries: listed.map(({ entry }) => entry),
    drift: driftOf(listed),
    running,
  };
}

/**
 * The settings a deployment would start with on a version, before it exists,
 * as the wizard that creates it lists them. Its first deploy writes the
 * version's value for a key the operator decides. A key one of its controls
 * decides has no value yet, because the manager works that out at the deploy.
 */
export function newDeploymentSettingsCatalogOf(input: NewDeploymentCatalogInput): NewDeploymentSettingsCatalog {
  const ownerContext = ownerContextOf(input.contract, input.isLocalTarget);
  const firstDeployEnv = Object.fromEntries(
    Object.entries(versionValuesOf(input)).filter(([key]) => settingOwnerOf(key, ownerContext) === null),
  );
  const listed = listedSettingsOf({ ...input, stored: NOTHING_STORED, nextEnv: firstDeployEnv, records: [] }, false);
  return { versionId: input.versionId, buildId: input.buildId, entries: listed.map(({ entry }) => entry) };
}

function listedSettingsOf(input: ListInput, running: boolean): ListedSetting[] {
  const readers = readersByKey(input.contract);
  const version = versionValuesOf(input);
  const ownerContext = ownerContextOf(input.contract, input.isLocalTarget);

  return listedKeysOf(input).map(({ sample: declared, isDeclared }) => {
    const key = declared.key;
    const secret = isSecretSettingKey(key);
    const services = readers.get(key) ?? null;
    const differing = differingServices(key, services, input);
    const owner = settingOwnerOf(key, ownerContext);
    return {
      entry: {
        key,
        section: declared.section,
        description: declared.description,
        declared: isDeclared,
        secret,
        sampleValue: declared.value ?? declared.example,
        versionSet: key in version,
        versionValue: secret || !(key in version) ? null : shown(key, version[key]!),
        stored: key in input.stored.plain || input.stored.secretKeys.includes(key),
        storedValue: secret ? null : (input.stored.plain[key] ?? null),
        value: secret || !(key in input.nextEnv) ? null : shown(key, input.nextEnv[key]!),
        source: sourceOf(key, input, owner !== null),
        owner,
        field: stackSettingFieldOf(key),
        services,
        running: runningStateOf(running, differing),
      } satisfies DeploymentSettingEntry,
      differing: differing === 'unknown' ? [] : differing,
    };
  });
}

/** What the version sets: the engine's file, and the root file over it, the way the deploy script reads them. */
function versionValuesOf(files: Pick<CatalogInput, 'baseEnvText' | 'engineEnvText'>): Record<string, string> {
  return { ...parseEnvText(files.engineEnvText), ...parseEnvText(files.baseEnvText) };
}

function ownerContextOf(contract: StackContract | null | undefined, isLocalTarget: boolean): SettingOwnerContext {
  return { ports: [...portTableOf(contract), ...(contract?.portAliases ?? [])], isLocalTarget };
}

/**
 * The root sample's keys, then the engine's the root does not declare, then
 * the keys the deployment stores that neither declares any more.
 */
function listedKeysOf(input: ListInput): { sample: SampleCatalogEntry; isDeclared: boolean }[] {
  const listed = new Map<string, { sample: SampleCatalogEntry; isDeclared: boolean }>();
  for (const sample of [...sampleCatalogOf(input.rootSampleText), ...sampleCatalogOf(input.engineSampleText)]) {
    if (!listed.has(sample.key)) listed.set(sample.key, { sample, isDeclared: true });
  }
  for (const key of [...Object.keys(input.stored.plain), ...input.stored.secretKeys]) {
    if (listed.has(key)) continue;
    listed.set(key, { sample: { key, section: '', description: '', value: null, example: null }, isDeclared: false });
  }
  return [...listed.values()];
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

function sourceOf(key: string, input: ListInput, owned: boolean): DeploymentSettingSource {
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
  input: ListInput,
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

function driftOf(entries: readonly ListedSetting[]): DeploymentSettingsDrift {
  const behind = entries.filter(({ differing }) => differing.length > 0);
  return {
    keys: behind.map(({ entry }) => entry.key),
    services: [...new Set(behind.flatMap(({ differing }) => differing))].sort(),
    fullRedeploy: behind.some(({ entry }) => entry.services === null),
  };
}
