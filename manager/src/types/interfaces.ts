import type {
  DeploymentPhase,
  EngineConfigState,
  EngineSettings,
} from '@streaming-infra-manager/common';

import { ProfileKind, ProfileStatus } from './types.js';

export interface Profile {
  name: string;
  port_slot: number;
  kind: ProfileKind;
  notes: string | null;
  /**
   * Moves with every change of the notes. A save carries the revision its
   * page loaded, and one whose revision has moved is refused rather than
   * applied over a newer note. See migrations/013.
   */
  notes_revision: number;
  components: string[] | null;
  host: string | null;
  feed_owner: string | null;
  feed_topic: string | null;
  private_key: string | null;
  public_key: string | null;
  stamp_id: string | null;
  /**
   * A pasted BEE_PUBLISHERS — the uploader publishes to an ABR node pool, which
   * may sit under another manager on another machine. NULL: publish through
   * this profile's own bee-uploader with `stamp_id`.
   */
  bee_publishers: string | null;
  /**
   * An explicit bee API URL for the stream-uploader. Only has effect when the
   * profile runs no `bee-uploader` — deploy.sh resolves BEE_URL itself whenever
   * one is enabled. NULL: whatever deploy.sh resolves.
   */
  bee_url: string | null;
  /** SRS only; null falls back to the base .env. See migrations/007. */
  srt_passphrase: string | null;
  /**
   * Engine settings this deployment overrides, by their env key. An absent key
   * means the stack's own default. See migrations/009 and
   * common/src/engineSettings.ts.
   */
  engine_settings: EngineSettings;
  /**
   * The engine runs on a config file of this deployment's own rather than the
   * stack's template. The file itself is read on its own, see migration 012.
   */
  has_engine_config: boolean;
  /** Why the last config file apply was reverted, or null. */
  engine_config_error: string | null;
  /** Where the last config file rollout stands, an operation state, or null before any. Migration 014. */
  engine_config_state: EngineConfigState | null;
  /** This deployment as distinct from a later one of the same name. Migration 014. */
  instance_id: string;
  /** Moves with every write of engine_config. Every such write names the revision it expects. */
  engine_config_revision: number;
  /** Moves with every operator action on the deployment, so an older rollout ends. */
  intent_revision: number;
  status: ProfileStatus;
  deployment_phase?: DeploymentPhase | null;
  last_error: string | null;
  last_error_at: Date | null;
  /** The commit of the last deploy that touched every service and found them agreeing, or null. */
  last_full_deploy_commit: string | null;
  created_at: Date;
  updated_at: Date;
  group_id: number | null;
  /** Which version of the streaming stack this deployment runs. Migration 010. */
  stack_version_id: number;
}

export interface DeploymentGroup {
  id: number;
  name: string;
  size: number;
  /** 'standard' fan-out, or 'abr-node-pool'. See migrations/004 and 005. */
  kind: string;
  created_at: Date;
}

export interface ApiContainer {
  service: string;
  ports: Record<string, number>;
  /** The build the container was seen to be started from, and its commit, or null before an observation. */
  buildId: string | null;
  buildCommit: string | null;
}

export interface ProfileWithContainers extends Profile {
  containers: ApiContainer[];
  /** Derived: uploader held back until a usable stamp is set. */
  pendingStamp: boolean;
}

export interface ActionInput {
  services?: string[];
  /** clean only */
  volumes?: boolean;
  /** clean only */
  all?: boolean;
}
