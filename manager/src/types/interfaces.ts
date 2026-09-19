import type {
  DeploymentPhase,
  EngineConfigState,
  EngineSettings,
  NodeMode,
  RpcEndpointSource,
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
  /**
   * Whether a signing key is stored, never the key itself. The value is read
   * on its own through `ProfileRepository.privateKeyOf`, at the one place that
   * writes it into a deployment's env file.
   */
  has_private_key: boolean;
  public_key: string | null;
  stamp_id: string | null;
  /**
   * A pasted BEE_PUBLISHERS: the uploader publishes to an ABR node pool, which
   * may sit under another manager on another machine. NULL: publish through
   * this profile's own bee-uploader with `stamp_id`.
   */
  bee_publishers: string | null;
  /**
   * An explicit bee API URL for the stream-uploader. Only has effect when the
   * profile runs no `bee-uploader`, because deploy.sh resolves BEE_URL itself
   * whenever one is enabled. NULL is then the address deploy.sh resolves, and
   * on a profile that uploads through no node of its own it is refused: see
   * beeTargetProblem, which makes such a deployment name a node or a pool.
   */
  bee_url: string | null;
  /** Whether this deployment stores a custom endpoint, never the URL itself. */
  has_rpc_endpoint: boolean;
  /** The custom endpoint's host and port, without its path, query or fragment. */
  rpc_endpoint_host: string | null;
  /**
   * Where that endpoint comes from: this manager's own configured one, the
   * stack's default, or a custom URL stored outside this public row. Only
   * `custom` carries an address of its own, and the column pairs the two. See
   * migrations/035.
   */
  rpc_endpoint_source: RpcEndpointSource;
  /**
   * How much of a chain this deployment's Bee node runs with, or null for the
   * mode the stack ships that node in: light for a bee-uploader, ultra-light
   * for a bee-gateway. Chosen when the deployment is created and not after.
   * See migrations/035 and common/src/nodeMode.ts.
   */
  node_mode: NodeMode | null;
  /**
   * Whether an SRT passphrase of this deployment's own is stored, never the
   * passphrase. SRS only, and false falls back to the base .env. The value is
   * read on its own through `ProfileRepository.srtPassphraseOf`: by the deploy,
   * which writes it into the env file, and by the page that builds the
   * broadcaster's SRT URL, which asks for one deployment's at a time. See
   * migrations/007.
   */
  has_srt_passphrase: boolean;
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
  /**
   * Derived: `host` with the ssh layer resolved away (userinfo dropped, a
   * dotless alias looked up in the ssh config). `host` is a *deploy* target and
   * an alias means nothing to a browser, so component links and the SRT publish
   * URL are built from this instead. Equal to `host` when there is nothing to
   * resolve.
   */
  network_host: string;
}

export interface ActionInput {
  services?: string[];
  /** clean only */
  all?: boolean;
}
