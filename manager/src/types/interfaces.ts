import { ProfileKind, ProfileStatus } from './types.js';

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

export interface ActionInput {
  services?: string[];
  /** clean only */
  volumes?: boolean;
  /** clean only */
  all?: boolean;
}
