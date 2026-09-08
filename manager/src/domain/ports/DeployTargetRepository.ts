export interface DeployTargetRecord {
  alias: string;
  daemonId: string | null;
  verifiedAt: Date | null;
  lastError: string | null;
}

export const DAEMON_CHANGED =
  'This target now reaches a different daemon. Its existing reservations need reconciliation before it can be used again.';

export interface DeployTargetRepository {
  list(): Promise<DeployTargetRecord[]>;
  find(alias: string): Promise<DeployTargetRecord | null>;
  /** Atomically retain the original identity and invalidate verification if an alias moved. */
  verified(alias: string, daemonId: string): Promise<DeployTargetRecord>;
  failed(alias: string, reason: string): Promise<void>;
}
