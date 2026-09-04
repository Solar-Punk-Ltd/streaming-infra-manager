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
  /** Pasted BEE_PUBLISHERS: publishes to an ABR node pool instead of its own node. */
  bee_publishers?: string | null;
  /** Explicit bee API URL. Only applies when no local bee-uploader runs. */
  bee_url?: string | null;
  /** SRS only; null falls back to the host-wide SRT_PASSPHRASE. */
  srt_passphrase?: string | null;
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
  /** 'standard' fan-out, or 'abr-node-pool'. */
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
  /** null clears it on update — the uploader goes back to its own node + stamp. */
  bee_publishers?: string | null;
  bee_url?: string | null;
  srt_passphrase?: string;
}
