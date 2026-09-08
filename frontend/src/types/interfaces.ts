import type { EngineSettings } from '@streaming-infra-manager/common';

import type { ProfileKind, ProfileStatus } from './types';

export interface Container {
  service: string;
  ports: Record<string, number>;
  /** The build the container was seen to be started from, and its commit, or null before an observation. */
  buildId: string | null;
  buildCommit: string | null;
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
  /**
   * Engine settings this deployment overrides, by env key. An absent key means
   * the stack default. The column is NOT NULL, so the object is always there.
   */
  engine_settings: EngineSettings;
  /** The engine runs on a config file of this deployment's own, not the stack's template. */
  has_engine_config: boolean;
  /** Why the last config file apply was reverted, or null. */
  engine_config_error: string | null;
  status: ProfileStatus;
  last_error: string | null;
  last_error_at: string | null;
  /** The commit of the last deploy that touched every service and found them agreeing, or null. */
  last_full_deploy_commit: string | null;
  created_at: string;
  updated_at: string;
  containers: Container[];
  group_id?: number | null;
  pendingStamp?: boolean;
  /** Which version of the streaming stack this deployment runs. */
  stack_version_id?: number | null;
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
  /** null clears it on update, the uploader goes back to its own node + stamp. */
  bee_publishers?: string | null;
  bee_url?: string | null;
  srt_passphrase?: string;
  /** The stack version to run. Absent means the manager's default one. */
  stack_version_id?: number;
}
