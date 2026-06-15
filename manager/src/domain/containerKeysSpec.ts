/**
 *
 * Mirrors the variable groupings in swarm-hls-stream/.env.sample.
 */
export const SERVICE_ENV_KEYS: Record<string, readonly string[]> = {
  srs: [
    'SRS_SRT_PORT',
    'SRT_PASSPHRASE',
    'SRS_ADAPTER_HOST',
    'SRS_ADAPTER_PORT',
    'SRS_MEDIA_PATH',
  ],
  ome: [
    'OME_SRT_PORT',
    'OME_HLS_PORT',
    'OME_ADAPTER_HOST',
    'OME_ADAPTER_PORT',
    'OME_HLS_URL',
  ],
  'stream-uploader': [
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
  'bee-uploader': [
    'BEE_UPLOADER_API_PORT',
    'BEE_UPLOADER_P2P_PORT',
    'BEE_UPLOADER_NAT_ADDR',
    'BEE_UPLOADER_FULL_NODE',
    'BEE_UPLOADER_DATA_DIR',
    'RPC_ENDPOINT',
    'BEE_VERBOSITY',
  ],
  'bee-gateway': [
    'BEE_GATEWAY_API_PORT',
    'BEE_GATEWAY_P2P_PORT',
    'BEE_GATEWAY_NAT_ADDR',
    'BEE_GATEWAY_DATA_DIR',
    'RPC_ENDPOINT',
    'BEE_VERBOSITY',
  ],
  client: [
    'VITE_READER_BEE_URL',
    'VITE_APP_OWNER',
    'VITE_APP_RAW_TOPIC',
    'CLIENT_PORT',
    'CLIENT_BEE_GATEWAY_HOST',
    'CLIENT_BEE_GATEWAY_PORT',
  ],
};

export const SERVICE_PORT_KEYS: Record<string, readonly string[]> = {
  srs: ['SRS_SRT_PORT', 'SRS_ADAPTER_PORT'],
  ome: ['OME_SRT_PORT', 'OME_HLS_PORT'],
  'stream-uploader': ['API_PORT'],
  'bee-uploader': ['BEE_UPLOADER_API_PORT', 'BEE_UPLOADER_P2P_PORT'],
  'bee-gateway': ['BEE_GATEWAY_API_PORT', 'BEE_GATEWAY_P2P_PORT'],
  client: ['CLIENT_PORT'],
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
