import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  type EngineName,
  engineSettingsFields,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

/**
 * The one engine setting the engine container never sees.
 *
 * `OME_HLS_POLL_INTERVAL_MS` is how often the uploader asks OvenMediaEngine
 * for a new segment, so compose puts it in the uploader's environment and
 * nowhere else. It is offered beside the OME settings because it is the same
 * decision to an operator, and it is listed here so the snapshot shows it
 * against the container that actually got it.
 *
 * `ProfileService.updateEngineSettings` reads the same list to decide which
 * containers a saved change has to recreate.
 */
export const UPLOADER_ENGINE_SETTING_KEYS: readonly string[] = [
  'OME_HLS_POLL_INTERVAL_MS',
];

function engineSettingKeysFor(engine: EngineName): string[] {
  return engineSettingsFields(engine)
    .map((field) => field.key)
    .filter((key) => !UPLOADER_ENGINE_SETTING_KEYS.includes(key));
}

/**
 *
 * Mirrors the variable groupings in swarm-hls-stream/.env.sample.
 */
export const SERVICE_ENV_KEYS: Record<string, readonly string[]> = {
  [SRS_SERVICE]: [
    'SRS_SRT_PORT',
    'SRS_HTTP_API_PORT',
    'SRT_PASSPHRASE',
    'SRS_ADAPTER_HOST',
    'SRS_ADAPTER_PORT',
    'SRS_MEDIA_PATH',
    'ABR_ENABLED',
    'ABR_LADDER',
    ...engineSettingKeysFor(SRS_SERVICE),
  ],
  [OME_SERVICE]: [
    'OME_SRT_PORT',
    'OME_HLS_PORT',
    'OME_ADAPTER_HOST',
    'OME_ADAPTER_PORT',
    'OME_HLS_URL',
    ...engineSettingKeysFor(OME_SERVICE),
  ],
  [STREAM_UPLOADER_SERVICE]: [
    'API_PORT',
    'BEE_URL',
    'MANIFEST_ACCESS_URL',
    'STATE_DIR',
    'MAX_QUEUE_SIZE',
    'RECOVERY_TIMEOUT',
    'ENGINE',
    'MEDIA_PATH',
    'STAMP',
    'STAMP_AMOUNT',
    'STAMP_DEPTH',
    'STAMP_IMMUTABLE',
    'STREAM_KEY',
    'STREAM_LIST_TOPIC',
    'BEE_PUBLISHERS',
    'ABR_ENABLED',
    'ABR_LADDER',
    ...UPLOADER_ENGINE_SETTING_KEYS,
  ],
  [BEE_UPLOADER_SERVICE]: [
    'BEE_UPLOADER_API_PORT',
    'BEE_UPLOADER_P2P_PORT',
    'BEE_UPLOADER_NAT_ADDR',
    'BEE_UPLOADER_FULL_NODE',
    'BEE_UPLOADER_DATA_DIR',
    'RPC_ENDPOINT',
    'BEE_VERBOSITY',
  ],
  [BEE_GATEWAY_SERVICE]: [
    'BEE_GATEWAY_API_PORT',
    'BEE_GATEWAY_P2P_PORT',
    'BEE_GATEWAY_NAT_ADDR',
    'BEE_GATEWAY_DATA_DIR',
    'BEE_GATEWAY_CACHE_CAPACITY',
    'RPC_ENDPOINT',
    'BEE_VERBOSITY',
  ],
  [CLIENT_SERVICE]: [
    'VITE_READER_BEE_URL',
    'VITE_APP_OWNER',
    'VITE_APP_RAW_TOPIC',
    'CLIENT_PORT',
    'CLIENT_BEE_GATEWAY_HOST',
    'CLIENT_BEE_GATEWAY_PORT',
  ],
};

export const SERVICE_PORT_KEYS: Record<string, readonly string[]> = {
  [SRS_SERVICE]: ['SRS_SRT_PORT', 'SRS_HTTP_API_PORT', 'SRS_ADAPTER_PORT'],
  [OME_SERVICE]: ['OME_SRT_PORT', 'OME_HLS_PORT'],
  [STREAM_UPLOADER_SERVICE]: ['API_PORT'],
  [BEE_UPLOADER_SERVICE]: ['BEE_UPLOADER_API_PORT', 'BEE_UPLOADER_P2P_PORT'],
  [BEE_GATEWAY_SERVICE]: ['BEE_GATEWAY_API_PORT', 'BEE_GATEWAY_P2P_PORT'],
  [CLIENT_SERVICE]: ['CLIENT_PORT'],
};

export interface ContainerSnapshot {
  service: string;
  ports: Record<string, number>;
  env: Record<string, string>;
}

export function buildContainerSnapshot(
  service: string,
  env: Record<string, string>,
): ContainerSnapshot {
  const envKeys = SERVICE_ENV_KEYS[service] ?? [];
  const portKeys = SERVICE_PORT_KEYS[service] ?? [];

  const envSubset: Record<string, string> = {};
  for (const key of envKeys) {
    const value = env[key];
    if (value !== undefined && value !== '') envSubset[key] = value;
  }

  const ports: Record<string, number> = {};
  for (const key of portKeys) {
    const raw = env[key];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) ports[key] = parsed;
  }

  return { service, ports, env: envSubset };
}
