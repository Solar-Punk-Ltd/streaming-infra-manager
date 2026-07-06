import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

/**
 *
 * Mirrors the variable groupings in swarm-hls-stream/.env.sample.
 */
export const SERVICE_ENV_KEYS: Record<string, readonly string[]> = {
  [SRS_SERVICE]: [
    'SRS_SRT_PORT',
    'SRT_PASSPHRASE',
    'SRS_ADAPTER_HOST',
    'SRS_ADAPTER_PORT',
    'SRS_MEDIA_PATH',
  ],
  [OME_SERVICE]: [
    'OME_SRT_PORT',
    'OME_HLS_PORT',
    'OME_ADAPTER_HOST',
    'OME_ADAPTER_PORT',
    'OME_HLS_URL',
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
  [SRS_SERVICE]: ['SRS_SRT_PORT', 'SRS_ADAPTER_PORT'],
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
