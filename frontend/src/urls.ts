import {
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  defaultServicesFor,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import type { Profile } from './types';

const LOCAL_HOSTS = new Set(['', 'localhost', '0.0.0.0', '127.0.0.1']);

export function hostFor(profile: Profile, serverHost: string): string {
  const profileHost = profile.host?.trim() ?? '';
  if (!LOCAL_HOSTS.has(profileHost)) return profileHost;
  return serverHost || window.location.hostname;
}

export function componentUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function clientUrl(profile: Profile, serverHost: string): string | null {
  const client = profile.containers.find((c) => c.service === CLIENT_SERVICE);
  if (!client) return null;
  const port = client.ports.CLIENT_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

/** The API of this deployment's own Bee node, when it runs one. */
export function beeApiUrl(profile: Profile, serverHost: string): string | null {
  const bee = profile.containers.find(
    (c) => c.service === BEE_UPLOADER_SERVICE,
  );
  const port = bee?.ports.BEE_UPLOADER_API_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

const SRT_DEFAULT_APP_STREAM = 'live/stream';
const SRS_SRT_BASE_PORT = 10001;
const OME_SRT_BASE_PORT = 10001;
const OME_DEFAULT_APP_STREAM = 'video/stream';

/**
 * The URL a publisher points OBS or FFmpeg at.
 *
 * `hostPassphrase` is the host-wide SRT_PASSPHRASE from `GET /config`. The
 * deployment's own passphrase outranks it, and a deployment that sets none falls
 * back to it, which is the same precedence the deploy applies when it writes
 * `.env.<profile>`. Only SRS reads a passphrase. OME's SRT listener has none.
 */
export function srtPublishUrl(
  profile: Profile,
  serverHost: string,
  hostPassphrase?: string | null,
): string | null {
  const host = hostFor(profile, serverHost);
  // The kind's default services count too: a viewer stores no components list,
  // and reading only the stored list handed every viewer an SRT URL for a port
  // nothing listens on.
  const services = defaultServicesFor(profile);

  const ome = profile.containers.find((c) => c.service === OME_SERVICE);
  if (ome || services.includes(OME_SERVICE)) {
    const port =
      ome?.ports.OME_SRT_PORT ??
      (profile.port_slot > 0
        ? OME_SRT_BASE_PORT + profile.port_slot * 10
        : null);
    if (!port) {
      return null;
    }

    return `srt://${host}:${port}?streamid=srt://${host}:${port}/${OME_DEFAULT_APP_STREAM}`;
  }

  const srs = profile.containers.find((c) => c.service === SRS_SERVICE);
  if (!srs && !services.includes(SRS_SERVICE)) {
    return null;
  }
  const port =
    srs?.ports.SRS_SRT_PORT ??
    (profile.port_slot > 0 ? SRS_SRT_BASE_PORT + profile.port_slot * 10 : null);
  if (!port) return null;
  const base = `srt://${host}:${port}?streamid=#!::r=${SRT_DEFAULT_APP_STREAM},m=publish`;
  const passphrase = profile.srt_passphrase?.trim() || hostPassphrase;
  return passphrase ? `${base}&passphrase=${passphrase}` : base;
}
