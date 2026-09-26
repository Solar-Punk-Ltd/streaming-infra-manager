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

import { digestOf, isRecordedInClear, newRecordSalt } from './settings/runningRecord.js';

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

/**
 * Engine settings that BOTH the engine and the uploader read, so a change to one
 * has to bring both containers back.
 *
 * ⛔ A separate list rather than an addition to
 * {@link UPLOADER_ENGINE_SETTING_KEYS}, because that one is filtered OUT of the
 * engine's own keys just below. A key both containers read, put there, would
 * disappear from the engine's environment.
 *
 * `HLS_FRAGMENT` is the only settings field in this position, read off
 * `deploy/docker-compose.yml` rather than assumed: the engine is asked
 * to cut at it and the uploader dates every segment by it. The other keys both
 * blocks set, ABR_ENABLED, ABR_LADDER, ABR_VHOST and SRS_WEBHOOK_TOKEN, are not
 * settings fields and never reach this decision.
 */
export const SHARED_ENGINE_SETTING_KEYS: readonly string[] = ['HLS_FRAGMENT'];

function engineSettingKeysFor(engine: EngineName): string[] {
  return engineSettingsFields(engine)
    .map((field) => field.key)
    .filter((key) => !UPLOADER_ENGINE_SETTING_KEYS.includes(key));
}

/**
 * The env keys each compose service reads, by service name.
 *
 * Mirrors the variable groupings in swarm-hls-stream/.env.sample.
 */
export const SERVICE_ENV_KEYS: Record<string, readonly string[]> = {
  [SRS_SERVICE]: [
    'SRS_SRT_PORT',
    'SRS_HTTP_API_PORT',
    'SRS_CONF_FILE',
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
    'OME_CONF_FILE',
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
    ...SHARED_ENGINE_SETTING_KEYS,
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
  // A gateway's endpoint is its own key, not the RPC_ENDPOINT the other Bee
  // services read. The stack gives this service an empty endpoint literal and
  // never interpolates that variable, so listing it here claimed the container
  // was started with something it has never read. The two keys below are what a
  // gateway an operator put on the chain is started with.
  [BEE_GATEWAY_SERVICE]: [
    'BEE_GATEWAY_API_PORT',
    'BEE_GATEWAY_P2P_PORT',
    'BEE_GATEWAY_NAT_ADDR',
    'BEE_GATEWAY_DATA_DIR',
    'BEE_GATEWAY_CACHE_CAPACITY',
    'BEE_GATEWAY_RPC_ENDPOINT',
    'BEE_GATEWAY_SWAP_ENABLE',
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
  [SRS_SERVICE]: ['SRS_SRT_PORT', 'SRS_HTTP_PORT', 'SRS_HTTP_API_PORT', 'SRS_ADAPTER_PORT'],
  [OME_SERVICE]: ['OME_SRT_PORT', 'OME_HLS_PORT'],
  [STREAM_UPLOADER_SERVICE]: ['API_PORT'],
  [BEE_UPLOADER_SERVICE]: ['BEE_UPLOADER_API_PORT', 'BEE_UPLOADER_P2P_PORT'],
  [BEE_GATEWAY_SERVICE]: ['BEE_GATEWAY_API_PORT', 'BEE_GATEWAY_P2P_PORT'],
  [CLIENT_SERVICE]: ['CLIENT_PORT'],
};

export interface ContainerSnapshot {
  service: string;
  ports: Record<string, number>;
  /** The keys the service reads that were set, not empty, and may be shown, each with its value. */
  env: Record<string, string>;
  /** Every key the record covers as a digest under `envSalt`, an unset one as its own digest. */
  envDigests: Record<string, string>;
  envSalt: string;
}

/**
 * What one service's container was started with, as recorded against it.
 *
 * `keys` are the keys the service reads, from the version's compose files
 * where its contract carries them, and from the list above where it does not.
 * `deployKeys` are the keys the version declares that no service reads, which
 * reach only the deploy scripts, and so decided how every container of that
 * deploy was started.
 *
 * A secret the service reads is kept as a digest and nothing else. The
 * deployment's own row keeps the one copy a deploy reads, and a record gains
 * nothing from holding a second: the digest is enough to tell whether a value
 * changed since the container started.
 */
export function buildContainerSnapshot(
  service: string,
  env: Record<string, string>,
  options: { keys?: readonly string[]; deployKeys?: readonly string[] } = {},
): ContainerSnapshot {
  const envKeys = [...new Set([...(options.keys ?? SERVICE_ENV_KEYS[service] ?? []), ...(options.deployKeys ?? [])])];
  const portKeys = SERVICE_PORT_KEYS[service] ?? [];
  const envSalt = newRecordSalt();

  const envSubset: Record<string, string> = {};
  const envDigests: Record<string, string> = {};
  for (const key of envKeys) {
    const value = env[key];
    envDigests[key] = digestOf(envSalt, key, value);
    if (value !== undefined && value !== '' && isRecordedInClear(key)) envSubset[key] = value;
  }

  const ports: Record<string, number> = {};
  for (const key of portKeys) {
    const raw = env[key];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) ports[key] = parsed;
  }

  return { service, ports, env: envSubset, envDigests, envSalt };
}

/**
 * The keys a version declares that no container's block reads. They reach the
 * deploy scripts alone, which is how they decide every container a deploy
 * starts, so each record covers them too.
 */
export function deployOnlyKeys(
  declared: Iterable<string>,
  serviceKeys: Readonly<Record<string, readonly string[]>>,
): string[] {
  const read = new Set(Object.values(serviceKeys).flat());
  return [...declared].filter((key) => !read.has(key)).sort();
}
