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
  group_id: number | null;
}

export interface DeploymentGroup {
  id: number;
  name: string;
  size: number;
  created_at: Date;
}

export interface ApiContainer {
  service: string;
  ports: Record<string, number>;
}

export interface ProfileWithContainers extends Profile {
  containers: ApiContainer[];
  /**
   * Derived: the profile wants the stream-uploader but has no usable stamp yet,
   * so the uploader is held back ("Stamp required"). The rest of the stack runs.
   */
  pendingStamp: boolean;
}

export interface ActionInput {
  services?: string[];
  /** clean only */
  volumes?: boolean;
  /** clean only */
  all?: boolean;
}
