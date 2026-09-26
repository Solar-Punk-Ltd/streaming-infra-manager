import {
  ENGINE_CONFIG_ENV_KEYS,
  OME_SERVICE,
  OME_SETTINGS,
  SRS_SERVICE,
  SRS_SETTINGS,
  type StackPortVar,
} from '@streaming-infra-manager/common';

/**
 * Who decides a key of a deployment's env file when the operator does not.
 *
 * Every key a deployment's build declares is the operator's to set per
 * deployment, with these exceptions. Each is decided by a control of its own,
 * because typing over it would break what the manager keeps track of: the port
 * slots, the node pool, the stamp a deployment pays with. The page shows such a
 * key with its value and points at the control that changes it.
 */
export type SettingOwner =
  /** Which services the deployment runs, and with them its engine. */
  | 'components'
  | 'stamp'
  | 'node-pool'
  | 'chain-endpoint'
  /** Whether the deployment's gateway runs on the chain. */
  | 'node-mode'
  | 'bee-url'
  | 'srt-passphrase'
  /** The key the deployment signs its feed with. */
  | 'feed-key'
  | 'feed-owner'
  | 'feed-topic'
  | 'engine-config'
  | 'engine-settings'
  | 'port-slot'
  | 'data-dir';

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

const ENGINE_SETTING_KEYS: ReadonlySet<string> = new Set(
  [...SRS_SETTINGS, ...OME_SETTINGS].map((field) => field.key),
);

/** What decides ownership beyond the key's name. */
export interface SettingOwnerContext {
  /** The version's port table, the aliases included. */
  ports: readonly StackPortVar[];
  /** Whether the deployment runs on the manager's own host, where its data directories are the manager's. */
  isLocalTarget: boolean;
}

/** The control that decides this key for a deployment, or null when the operator does. */
export function settingOwnerOf(key: string, context: SettingOwnerContext): SettingOwner | null {
  const field = FIELD_OWNERS[key];
  if (field) return field;
  if (ENGINE_SETTING_KEYS.has(key)) return 'engine-settings';
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
