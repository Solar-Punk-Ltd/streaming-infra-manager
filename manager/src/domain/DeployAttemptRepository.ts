import type {
  AttemptOutcome,
  DeployAttempt,
  DeployAttemptKind,
} from './deployAttempts.js';

export interface NewDeployAttempt {
  daemonId: string;
  target?: string | null;
  project: string;
  jobId: string;
  kind: DeployAttemptKind;
  services: readonly string[];
  preJobContainerIds: readonly string[];
}

/**
 * The durable rows of the project guard and the daemon lock. `open` applies
 * the admission rules and inserts in one transaction under a lock per
 * daemon, so two attempts admitted together cannot both pass, and throws
 * `DeployAttemptRefusedError` naming what holds the guard.
 */
export interface DeployAttemptRepository {
  open(attempt: NewDeployAttempt): Promise<DeployAttempt>;
  findByJob(jobId: string): Promise<DeployAttempt | null>;
  listUnresolved(daemonId?: string): Promise<DeployAttempt[]>;
  listBlocked(): Promise<DeployAttempt[]>;
  /** Open to released or blocked, by evidence. */
  resolve(id: number, outcome: AttemptOutcome): Promise<DeployAttempt | null>;
  /** Released by a person who checked the host, from any unresolved state. */
  release(id: number, by: string): Promise<DeployAttempt | null>;
  /**
   * Every unresolved attempt of a project on the daemon released, for a
   * deployment that is being removed: its containers are gone, and the name
   * may be used again. Answers what was released.
   */
  releaseProject(daemonId: string, project: string, by: string): Promise<DeployAttempt[]>;
}

/** What Docker says about the project an attempt is about. */
export interface DaemonSnapshot {
  daemonId: string;
  containers: Map<string, string[]>;
}

export interface DaemonObserver {
  /** One target observation, including the identity of the daemon that supplied the containers. */
  snapshot(project: string, target?: string): Promise<DaemonSnapshot>;
  /** The daemon's own id, from `docker info`, so a lock never crosses hosts. */
  daemonId(target?: string): Promise<string>;
  /** Every container of the project by service, all states. */
  containerIdsOf(project: string, target?: string): Promise<Map<string, string[]>>;
}
