import {
  ENGINE_CONFIG_ENV_KEYS,
  type EngineName,
  engineOfSettingKey,
  engineSettingFieldOf,
  OME_SERVICE,
  SRS_SERVICE,
  type SettingOwner,
  type StackPortVar,
} from '@streaming-infra-manager/common';

/**
 * Keys written from one of the deployment's own fields, by `managedEnvLines` or
 * as a deploy script argument, each with the control that sets that field.
 */
const FIELD_OWNERS: Readonly<Record<string, SettingOwner>> = {
  ENGINE: 'components',
  LOCAL_BEE_UPLOADER: 'components',
  STAMP: 'stamp',
  BEE_PUBLISHERS: 'node-pool',
  ABR_ENABLED: 'node-pool',
  ABR_LADDER: 'node-pool',
  RPC_ENDPOINT: 'chain-endpoint',
  BEE_GATEWAY_RPC_ENDPOINT: 'node-mode',
  BEE_GATEWAY_SWAP_ENABLE: 'node-mode',
  BEE_URL: 'bee-url',
  SRT_PASSPHRASE: 'srt-passphrase',
  STREAM_KEY: 'feed-key',
  VITE_APP_OWNER: 'feed-owner',
  STREAM_LIST_TOPIC: 'feed-topic',
  VITE_APP_RAW_TOPIC: 'feed-topic',
  [ENGINE_CONFIG_ENV_KEYS[SRS_SERVICE]]: 'engine-config',
  [ENGINE_CONFIG_ENV_KEYS[OME_SERVICE]]: 'engine-config',
};

/** Ports `deploy.sh` works out from a slotted port rather than from the table itself. */
const DERIVED_PORT_KEYS: readonly string[] = [
  'SRS_ADAPTER_PORT',
  'OME_ADAPTER_PORT',
  'OME_SRT_PORT',
  'OME_HLS_PORT',
];

/** Exported to the deploy script on the manager's own host, which beats any line of the file. */
const DATA_DIR_KEYS: readonly string[] = ['BEE_UPLOADER_DATA_DIR', 'BEE_GATEWAY_DATA_DIR'];

/** Who reads each engine's settings, when one reads none of them. */
const ENGINE_ONLY_OWNER: Readonly<Record<EngineName, SettingOwner>> = {
  [SRS_SERVICE]: 'srs-only',
  [OME_SERVICE]: 'ome-only',
};

/** The deployment whose settings list decides who sets an engine setting. */
export interface EngineSettingsReader {
  /** The media server it runs, or null for one that runs none. */
  engine: EngineName | null;
  /** Whether it encodes the ABR ladder, so the rung settings are its own. */
  abr: boolean;
}

/** What decides ownership beyond the key's name. */
export interface SettingOwnerContext {
  /** The version's port table, the aliases included. */
  ports: readonly StackPortVar[];
  /** Whether the deployment runs on the manager's own host, where its data directories are the manager's. */
  isLocalTarget: boolean;
  /**
   * The deployment a settings list is for, which sets the engine settings it
   * reads in that list. Absent, every engine setting is the engine settings'
   * own, which is the wizard's list, whose engine settings are a step of their
   * own, and the deploy's, which writes the engine settings on their own.
   */
  engineReader?: EngineSettingsReader;
}

/** Who sets an engine setting: the operator in the list, the engine settings, or nobody the deployment has. */
function engineSettingOwnerOf(key: string, engine: EngineName, reader: EngineSettingsReader | undefined): SettingOwner | null {
  if (!reader) return 'engine-settings';
  if (reader.engine !== engine) return ENGINE_ONLY_OWNER[engine];
  if (engineSettingFieldOf(key)?.abrOnly && !reader.abr) return 'abr-only';
  return null;
}

/** The control that decides this key for a deployment, or why the deployment does not read it, or null when the operator decides it. */
export function settingOwnerOf(key: string, context: SettingOwnerContext): SettingOwner | null {
  const field = FIELD_OWNERS[key];
  if (field) return field;
  const engine = engineOfSettingKey(key);
  if (engine) return engineSettingOwnerOf(key, engine, context.engineReader);
  if (DERIVED_PORT_KEYS.includes(key) || context.ports.some((port) => port.name === key)) {
    return 'port-slot';
  }
  if (context.isLocalTarget && DATA_DIR_KEYS.includes(key)) return 'data-dir';
  return null;
}

/** The stored values of keys the operator decides, and the names of those another control decides. */
export interface OperatorSettings {
  values: Record<string, string>;
  ownedElsewhere: string[];
}

/** Splits a deployment's stored settings into the ones its env file takes and the ones a control overrides. */
export function operatorSettingsOf(
  stored: Readonly<Record<string, string>>,
  context: SettingOwnerContext,
): OperatorSettings {
  const values: Record<string, string> = {};
  const ownedElsewhere: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (settingOwnerOf(key, context) === null) values[key] = value;
    else ownedElsewhere.push(key);
  }
  return { values, ownedElsewhere };
}
