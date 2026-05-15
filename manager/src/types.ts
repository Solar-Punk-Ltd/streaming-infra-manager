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

/**
 * Profile lifecycle status — matches the CHECK constraint in 001_init.sql.
 *
 * Transitional states (in-flight script runs):
 *   DEPLOYING — deploy.sh running
 *   STOPPING  — stop.sh running
 *   REMOVING  — clean.sh running, row will be deleted on success
 *
 * Terminal states (idle, accept new triggers):
 *   RUNNING   — last deploy succeeded
 *   STOPPED   — last stop succeeded
 *   ERROR     — last script run failed; last_error has the message
 */
export const PROFILE_STATUSES = [
  'DEPLOYING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'REMOVING',
  'ERROR',
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const TRANSITIONAL_STATUSES: readonly ProfileStatus[] = [
  'DEPLOYING',
  'STOPPING',
  'REMOVING',
];

/** Shape returned to API clients (and stored in DB). */
export interface Profile {
  name: string;
  port_slot: number;
  kind: ProfileKind;
  notes: string | null;
  components: string[] | null;
  host: string | null;
  feed_owner: string | null;
  feed_topic: string | null;
  private_key: string | null;
  public_key: string | null;
  stamp_id: string | null;
  status: ProfileStatus;
  last_error: string | null;
  last_error_at: Date | null;
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
