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
  /** ssh target from ~/.ssh/config used for attach-mode transport + fault injection. */
  sshTarget: string;
  /** Public host/IP the SRT publisher and viewer reach from where the tests run. */
  publicHost: string;
  /** docker-compose project name = profile; also the container-name prefix. */
  profile: string;
  portSlot: number;
  ports: Ports;
  /** HLS stream path used in the SRT streamid (e.g. "live/stream"). */
  streamPath: string;
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

function parsePortSlot(raw: string): number {
  const slot = Number(raw);
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`Invalid E2E_PORT_SLOT "${raw}"; expected a non-negative integer`);
  }
  return slot;
}

export function loadConfig(): E2EConfig {
  const mode = parseMode(env('E2E_MODE', 'attach'));
  if (mode === 'deploy') {
    throw new Error(
      'E2E_MODE=deploy is not implemented yet — the suite only supports attach mode. ' +
        'Deploy a profile yourself and point the suite at it (set E2E_PROFILE / E2E_PUBLIC_HOST).',
    );
  }
  const portSlot = parsePortSlot(env('E2E_PORT_SLOT', '2'));
  return {
    mode,
    sshTarget: env('E2E_SSH_TARGET', 'manager-host'),
    publicHost: env('E2E_PUBLIC_HOST', '127.0.0.1'),
    profile: env('E2E_PROFILE', 'srs-check-test1'),
    portSlot,
    ports: portsForSlot(portSlot),
    streamPath: env('E2E_STREAM_PATH', 'live/stream'),
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

/** SRT publish URL matching the OBS ingest string: srt://host:port?streamid=#!::r=<path>,m=publish */
export function srtIngestUrl(cfg: E2EConfig): string {
  return `srt://${cfg.publicHost}:${cfg.ports.srt}?streamid=#!::r=${cfg.streamPath},m=publish`;
}
