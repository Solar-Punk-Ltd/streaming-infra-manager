export const PROFILE_KINDS = ['streamer', 'viewer', 'custom'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

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
  custom: [],
};

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

export interface ApiContainer {
  service: string;
  ports: Record<string, number>;
}

export interface ProfileWithContainers extends Profile {
  containers: ApiContainer[];
}

export type ActionKind = 'deploy' | 'stop' | 'clean' | 'health';

export interface ActionInput {
  services?: string[];
  /** clean only */
  volumes?: boolean;
  /** clean only */
  all?: boolean;
}
