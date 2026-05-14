export type ProfileKind = 'streamer' | 'viewer' | 'custom';

export type ProfileStatus =
  | 'DEPLOYING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'REMOVING'
  | 'ERROR';

export interface Profile {
  name: string;
  port_slot: number;
  kind: ProfileKind;
  notes: string | null;
  feed_owner?: string | null;
  feed_topic?: string | null;
  private_key?: string | null;
  public_key?: string | null;
  stamp_id?: string | null;
  status: ProfileStatus;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Container {
  service: string;
  ports: { label: string; port: number }[];
}
