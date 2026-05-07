/** Profile kind enum — matches the CHECK constraint in 001_init.sql. */
export const PROFILE_KINDS = ['streamer', 'viewer', 'custom'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** Service catalog. Keep in sync with swarm-hls-stream/deploy/scripts/_lib.sh::ALL_SERVICES. */
export const ALL_SERVICES = [
  'bee-uploader',
  'bee-gateway',
  'stream-uploader',
  'srs',
  'client',
] as const;
export type ServiceName = (typeof ALL_SERVICES)[number];

export function isService(s: string): s is ServiceName {
  return (ALL_SERVICES as readonly string[]).includes(s);
}

/** Default service set per profile kind. Overridable per request. */
export const KIND_DEFAULT_SERVICES: Record<
  ProfileKind,
  readonly ServiceName[]
> = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  viewer: ['client', 'bee-gateway'],
  // 'custom' has no default — caller passes services or accepts whatever
  // the script considers enabled in config.json.
  custom: [],
};

/** Shape returned to API clients (and stored in DB). */
export interface Profile {
  name: string;
  port_prefix: number;
  kind: ProfileKind;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ActionKind = 'deploy' | 'stop' | 'clean' | 'health';

export interface ActionInput {
  services?: string[];
  /** clean only */
  volumes?: boolean;
  /** clean only */
  all?: boolean;
}
