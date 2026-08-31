import type { ProfileKind, ProfileStatus } from './types';

export interface Container {
  service: string;
  ports: Record<string, number>;
}

export interface Profile {
  name: string;
  port_slot: number;
  kind: ProfileKind;
  notes: string | null;
  host?: string | null;
  components?: string[] | null;
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
  containers: Container[];
  group_id?: number | null;
  pendingStamp?: boolean;
}

export interface DeploymentGroup {
  id: number;
  name: string;
  size: number;
  /** 'standard' fan-out, or 'abr-ladder'. */
  kind: string;
  created_at: string;
}

export interface CreateProfileBody {
  name: string;
  kind: ProfileKind;
  notes?: string | null;
  host?: string;
  components?: string[];
  feed_owner?: string;
  private_key?: string;
  public_key?: string;
  stamp_id?: string;
}
