/**
 * E2E target configuration ("the direction").
 *
 * Two modes:
 *  - 'attach' (default): connect to an already-deployed profile on the host and discover its
 *    live stamp. Uses ssh for read-only inspection + container fault injection only — no deploy,
 *    no BZZ. This is the safe default that mirrors the manual `docker stop bee-uploader` flow.
 *  - 'deploy': bring a profile up fresh via the manager API before testing (heavier, opt-in).
 *
 * Every field is overridable via an E2E_* env var so the same suite can point at another
 * host/profile without code changes.
 */

// Load a local .env (if present) so the suite can be pointed at any deployment without code edits.
// Shell-exported vars still win over .env — e.g. `E2E_ENGINE=ome pnpm test:e2e` overrides a .env.
import 'dotenv/config';

export const MODES = ['attach', 'deploy'] as const;
export type Mode = (typeof MODES)[number];

export const ENGINES = ['srs', 'ome'] as const;
export type EngineName = (typeof ENGINES)[number];

/** Default HLS/ingest stream path per engine (OME apps must be `video` or `audio`, not `live`). */
const DEFAULT_STREAM_PATH: Record<EngineName, string> = {
  srs: 'live/stream',
  ome: 'video/stream',
};

/** OME's SRT provider port on the host — OME deploys standalone, off the per-profile port slot. */
const DEFAULT_OME_SRT_PORT = 10080;
/** OME's compose sets a fixed `container_name`, so it is not `<profile>-ome-1`. */
const DEFAULT_OME_CONTAINER = 'ome';

export interface Ports {
  uploaderApi: number;
  srt: number;
  rtmp: number;
  srsHttp: number;
  client: number;
  beeUploaderApi: number;
  beeGatewayApi: number;
}

/**
 * Port-slot base numbers, mirrored from the manager's DeploymentOrchestrator. A profile's ports
 * are these bases shifted by portSlot * PORT_SLOT_STRIDE (e.g. srs-check-test1 = slot 2 → SRT 10021).
 */
const PORT_SLOT_STRIDE = 10;
const PORT_BASE: Ports = {
  uploaderApi: 10000,
  srt: 10001,
  rtmp: 10002,
  srsHttp: 10003,
  client: 10004,
  beeUploaderApi: 10005,
  beeGatewayApi: 10007,
};

export function portsForSlot(slot: number): Ports {
  const shift = slot * PORT_SLOT_STRIDE;
  return {
    uploaderApi: PORT_BASE.uploaderApi + shift,
    srt: PORT_BASE.srt + shift,
    rtmp: PORT_BASE.rtmp + shift,
    srsHttp: PORT_BASE.srsHttp + shift,
    client: PORT_BASE.client + shift,
    beeUploaderApi: PORT_BASE.beeUploaderApi + shift,
    beeGatewayApi: PORT_BASE.beeGatewayApi + shift,
  };
}

export interface E2EConfig {
  mode: Mode;
  /** Media engine the target profile runs; selects the SRT streamid form, log markers, /health.engines. */
  engine: EngineName;
  /** ssh target from ~/.ssh/config used for attach-mode transport + fault injection. */
  sshTarget: string;
  /** Public host/IP the SRT publisher and viewer reach from where the tests run. */
  publicHost: string;
  /** docker-compose project name = profile; also the container-name prefix. */
  profile: string;
  portSlot: number;
  ports: Ports;
  /** HLS stream path used in the SRT streamid (SRS `live/<name>`, OME `video|audio/<name>`). */
  streamPath: string;
  /** OME SRT ingest port on the host (OME-only; OME deploys standalone, off the profile port slot). */
  omeSrtPort: number;
  /** OME container name for the engine-restart scenario (OME's compose sets a fixed container_name). */
  omeContainer: string;
  /** Manager API base (deploy mode only), typically the local tunnel to the host. */
  managerApiBase: string;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseMode(raw: string): Mode {
  if ((MODES as readonly string[]).includes(raw)) {
    return raw as Mode;
  }
  throw new Error(`Invalid E2E_MODE "${raw}"; expected one of: ${MODES.join(', ')}`);
}

function parseEngine(raw: string): EngineName {
  if ((ENGINES as readonly string[]).includes(raw)) {
    return raw as EngineName;
  }
  throw new Error(`Invalid E2E_ENGINE "${raw}"; expected one of: ${ENGINES.join(', ')}`);
}

function parsePortSlot(raw: string): number {
  const slot = Number(raw);
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`Invalid E2E_PORT_SLOT "${raw}"; expected a non-negative integer`);
  }
  return slot;
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name} "${raw}"; expected a port in 1–65535`);
  }
  return port;
}

export function loadConfig(): E2EConfig {
  const mode = parseMode(env('E2E_MODE', 'attach'));
  if (mode === 'deploy') {
    throw new Error(
      'E2E_MODE=deploy is not implemented yet — the suite only supports attach mode. ' +
        'Deploy a profile yourself and point the suite at it (set E2E_PROFILE / E2E_PUBLIC_HOST).',
    );
  }
  const engine = parseEngine(env('E2E_ENGINE', 'srs'));
  const portSlot = parsePortSlot(env('E2E_PORT_SLOT', '2'));
  return {
    mode,
    engine,
    sshTarget: env('E2E_SSH_TARGET', 'manager-host'),
    publicHost: env('E2E_PUBLIC_HOST', '127.0.0.1'),
    profile: env('E2E_PROFILE', 'srs-check-test1'),
    portSlot,
    ports: portsForSlot(portSlot),
    streamPath: env('E2E_STREAM_PATH', DEFAULT_STREAM_PATH[engine]),
    omeSrtPort: parsePort('E2E_OME_SRT_PORT', env('E2E_OME_SRT_PORT', String(DEFAULT_OME_SRT_PORT))),
    omeContainer: env('E2E_OME_CONTAINER', DEFAULT_OME_CONTAINER),
    managerApiBase: env('E2E_MANAGER_API', 'http://localhost:8080'),
  };
}

export const SERVICES = {
  srs: 'srs',
  streamUploader: 'stream-uploader',
  beeUploader: 'bee-uploader',
  beeGateway: 'bee-gateway',
  client: 'client',
} as const;

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

/** docker-compose default container name for a profile service (`<profile>-<service>-1`). */
export function containerName(cfg: E2EConfig, service: ServiceName): string {
  return `${cfg.profile}-${service}-1`;
}
