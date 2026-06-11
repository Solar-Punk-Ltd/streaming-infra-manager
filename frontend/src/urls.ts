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
  const client = profile.containers.find((c) => c.service === 'client');
  if (!client) return null;
  const port = client.ports.CLIENT_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

const SRT_DEFAULT_APP_STREAM = 'live/stream';
const SRS_SRT_BASE_PORT = 10001;

export function srtPublishUrl(
  profile: Profile,
  serverHost: string,
  passphrase?: string | null,
): string | null {
  const srs = profile.containers.find((c) => c.service === 'srs');
  const port =
    srs?.ports.SRS_SRT_PORT ??
    (profile.port_slot > 0
      ? SRS_SRT_BASE_PORT + profile.port_slot * 10
      : null);
  if (!port) return null;
  const host = hostFor(profile, serverHost);
  const base = `srt://${host}:${port}?streamid=#!::r=${SRT_DEFAULT_APP_STREAM},m=publish`;
  return passphrase ? `${base}&passphrase=${passphrase}` : base;
}
