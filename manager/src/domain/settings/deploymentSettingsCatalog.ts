import {
  configuredBeeRpcEndpoint,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  type DeploymentSettingSource,
  type DeploymentSettingsDrift,
  type EngineDefaults,
  type EngineName,
  type EngineSettingField,
  type EngineSettings,
  engineOfSettingKey,
  engineSettingsFieldsFor,
  isNotReadOwner,
  isSecretSettingKey,
  type NewDeploymentSettingsCatalog,
  type SettingOwner,
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
import { type EngineSettingsReader, type SettingOwnerContext, settingOwnerOf } from './settingOwners.js';

/**
 * The engine settings of a deployment that runs a media server, as its list
 * shows them: the fields it reads, what it stores, and what each unset one
 * falls back to on its host.
 */
export interface DeploymentEngineSettings {
  engine: EngineName;
  /** Whether it encodes the ABR ladder, so the rung settings are its own. */
  abr: boolean;
  /** Only the keys the deployment overrides, as `profiles.engine_settings` holds them. */
  stored: EngineSettings;
  /** What each unset key falls back to on the deployment's host, and where from, as the Engine card names them. */
  defaults: EngineDefaults;
  /** The keys the config the engine runs no longer reads, as the Engine card works them out. */
  notInConfig: readonly string[];
}

/** Everything a deployment's settings list is worked out from, read by the caller. */
export interface CatalogInput {
  profile: Profile;
  /** The engine whose sample the version's keys are read from. */
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
  /** The deployment's own engine settings, or null for one that runs no media server. */
  engineSettings: DeploymentEngineSettings | null;
  /** Why the next deploy would refuse the engine settings the deployment stores, as `nextEnvFor` answers it, or null. */
  engineSettingsProblem: string | null;
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
type ListInput = Omit<CatalogInput, 'profile' | 'engine' | 'buildId' | 'revision' | 'engineSettingsProblem'> & {
  /** The deployment the list is for, which sets the engine settings it reads. Absent for one not created yet. */
  engineReader?: EngineSettingsReader;
};

/** One key as the list answers it, with the services whose running container got another value. */
interface ListedSetting {
  entry: DeploymentSettingEntry;
  differing: string[];
}

/** What every entry says of a key, whoever sets it. */
type EntryBase = Pick<DeploymentSettingEntry, 'key' | 'section' | 'description' | 'sampleValue' | 'services' | 'running'>;

/** What the deployment stores for a key: in its engine settings for an engine setting, in the stack columns for any other. */
interface StoredKey {
  stored: boolean;
  /** Null for a secret, whose value the list never answers, and for a key nothing is stored for. */
  value: string | null;
}

/** The statuses whose containers run, so Apply means something. */
const RUNNING_STATUSES: readonly string[] = ['RUNNING', 'ERROR'];

const NOTHING_STORED: CatalogInput['stored'] = { plain: {}, secretKeys: [] };

/** A deployment's settings as its page lists them. */
export function deploymentSettingsCatalogOf(input: CatalogInput): DeploymentSettingsCatalog {
  const running = RUNNING_STATUSES.includes(input.profile.status);
  const engine = input.engineSettings?.engine ?? null;
  const abr = input.engineSettings?.abr ?? false;
  const listed = listedSettingsOf({ ...input, engineReader: { engine, abr } }, running);
  return {
    instanceId: input.profile.instance_id,
    revision: input.revision,
    buildId: input.buildId,
    entries: listed.map(({ entry }) => entry),
    drift: driftOf(listed),
    running,
    engine,
    abr,
    engineSettingsProblem: input.engineSettingsProblem,
  };
}

/**
 * The settings a deployment would start with on a version, before it exists,
 * as the wizard that creates it lists them. Its first deploy writes the
 * version's value for a key the operator decides. A key one of its controls
 * decides has no value yet, because the manager works that out at the deploy.
 * The wizard asks for its segment length in a field of its own and leaves the
 * other engine settings to its page, so none is offered here.
 */
export function newDeploymentSettingsCatalogOf(input: NewDeploymentCatalogInput): NewDeploymentSettingsCatalog {
  const ownerContext = ownerContextOf(input.contract, input.isLocalTarget, undefined);
  const firstDeployEnv = Object.fromEntries(
    Object.entries(versionValuesOf(input)).filter(([key]) => settingOwnerOf(key, ownerContext) === null),
  );
  const listed = listedSettingsOf(
    { ...input, stored: NOTHING_STORED, engineSettings: null, nextEnv: firstDeployEnv, records: [] },
    false,
  );
  return { versionId: input.versionId, buildId: input.buildId, entries: listed.map(({ entry }) => entry) };
}

function listedSettingsOf(input: ListInput, running: boolean): ListedSetting[] {
  const readers = readersByKey(input.contract);
  const version = versionValuesOf(input);
  const ownerContext = ownerContextOf(input.contract, input.isLocalTarget, input.engineReader);
  const engineFields = ownEngineFieldsOf(input.engineSettings);

  return listedKeysOf(input, engineFields).map(({ sample: declared, isDeclared }) => {
    const key = declared.key;
    const services = readers.get(key) ?? null;
    const differing = differingServices(key, services, input);
    const base: EntryBase = {
      key,
      section: declared.section,
      description: declared.description,
      sampleValue: declared.value ?? declared.example,
      services,
      running: runningStateOf(running, differing),
    };
    const stored = storedKeyOf(key, input);
    const entry = input.engineSettings && engineFields.has(key)
      ? engineSettingEntryOf(base, stored, input.engineSettings, input.nextEnv)
      : settingEntryOf(base, { stored, isDeclared, owner: settingOwnerOf(key, ownerContext), version, input });
    return { entry, differing: differing === 'unknown' ? [] : differing };
  });
}

/**
 * An engine setting the deployment reads, which the operator sets here. Its
 * default is what an unset key falls back to on the deployment's host, as the
 * Engine card names it, and a stored value is the deployment's own.
 */
function engineSettingEntryOf(
  base: EntryBase,
  stored: StoredKey,
  engineSettings: DeploymentEngineSettings,
  nextEnv: Readonly<Record<string, string>>,
): DeploymentSettingEntry {
  const defaultSource = engineSettings.defaults.sources[base.key] ?? 'stack';
  const source: DeploymentSettingSource = stored.stored ? 'deployment' : defaultSource === 'manager' ? 'manager-default' : 'version';
  return {
    ...base,
    declared: true,
    secret: false,
    versionSet: true,
    versionValue: engineSettings.defaults.values[base.key] ?? null,
    stored: stored.stored,
    storedValue: stored.value,
    value: nextEnv[base.key] ?? null,
    source,
    owner: null,
    field: null,
    engineSetting: { defaultSource, notInConfig: engineSettings.notInConfig.includes(base.key) },
  };
}

/** Every other key: set here by the operator, decided by a control, or an engine setting the deployment does not read. */
function settingEntryOf(
  base: EntryBase,
  facts: {
    stored: StoredKey;
    isDeclared: boolean;
    owner: SettingOwner | null;
    version: Readonly<Record<string, string>>;
    input: ListInput;
  },
): DeploymentSettingEntry {
  const { key } = base;
  const { stored, owner, version, input } = facts;
  const secret = isSecretSettingKey(key);
  return {
    ...base,
    declared: facts.isDeclared,
    secret,
    versionSet: key in version,
    versionValue: secret || !(key in version) ? null : shown(key, version[key]!),
    stored: stored.stored,
    storedValue: stored.value,
    value: secret || !(key in input.nextEnv) ? null : shown(key, input.nextEnv[key]!),
    source: sourceOf(key, input, stored.stored, owner),
    owner,
    field: stackSettingFieldOf(key),
    engineSetting: null,
  };
}

/** The engine settings the deployment reads, by key, which the operator sets in its list. */
function ownEngineFieldsOf(engineSettings: DeploymentEngineSettings | null): ReadonlyMap<string, EngineSettingField> {
  if (!engineSettings) return new Map();
  const fields = engineSettingsFieldsFor(engineSettings.engine, { abr: engineSettings.abr });
  return new Map(fields.map((field) => [field.key, field]));
}

/** What the deployment stores for a key, never a secret's value. */
function storedKeyOf(key: string, input: ListInput): StoredKey {
  if (engineOfSettingKey(key) !== null) {
    const value = input.engineSettings?.stored[key];
    return { stored: value !== undefined, value: value ?? null };
  }
  const stored = key in input.stored.plain || input.stored.secretKeys.includes(key);
  return { stored, value: isSecretSettingKey(key) ? null : (input.stored.plain[key] ?? null) };
}

/** What the version sets: the engine's file, and the root file over it, the way the deploy script reads them. */
function versionValuesOf(files: Pick<CatalogInput, 'baseEnvText' | 'engineEnvText'>): Record<string, string> {
  return { ...parseEnvText(files.engineEnvText), ...parseEnvText(files.baseEnvText) };
}

function ownerContextOf(
  contract: StackContract | null | undefined,
  isLocalTarget: boolean,
  engineReader: EngineSettingsReader | undefined,
): SettingOwnerContext {
  return {
    ports: [...portTableOf(contract), ...(contract?.portAliases ?? [])],
    isLocalTarget,
    ...(engineReader ? { engineReader } : {}),
  };
}

const UNDECLARED: Omit<SampleCatalogEntry, 'key'> = { section: '', description: '', value: null, example: null };

/**
 * The root sample's keys, then the engine's the root does not declare, then
 * the engine settings the deployment reads that neither declares, in the
 * field list's order, then the keys the deployment stores that none of those
 * name any more.
 */
function listedKeysOf(
  input: ListInput,
  engineFields: ReadonlyMap<string, EngineSettingField>,
): { sample: SampleCatalogEntry; isDeclared: boolean }[] {
  const listed = new Map<string, { sample: SampleCatalogEntry; isDeclared: boolean }>();
  for (const sample of [...sampleCatalogOf(input.rootSampleText), ...sampleCatalogOf(input.engineSampleText)]) {
    if (!listed.has(sample.key)) listed.set(sample.key, { sample, isDeclared: true });
  }
  for (const key of engineFields.keys()) {
    if (!listed.has(key)) listed.set(key, { sample: { key, ...UNDECLARED }, isDeclared: true });
  }
  const storedKeys = [
    ...Object.keys(input.stored.plain),
    ...input.stored.secretKeys,
    ...Object.keys(input.engineSettings?.stored ?? {}),
  ];
  for (const key of storedKeys) {
    if (!listed.has(key)) listed.set(key, { sample: { key, ...UNDECLARED }, isDeclared: false });
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

/**
 * Where the value of a key other than the deployment's own engine settings
 * comes from. A control's own key is the manager's. An engine setting the
 * deployment does not read has nothing deciding it, so it is what is stored or
 * set for it, as for any key.
 */
function sourceOf(key: string, input: ListInput, stored: boolean, owner: SettingOwner | null): DeploymentSettingSource {
  if (owner !== null && !isNotReadOwner(owner)) return 'manager';
  if (stored) return 'deployment';
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
