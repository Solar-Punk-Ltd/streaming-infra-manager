export interface DeployTargetView {
  alias: string;
  daemonId: string | null;
  verifiedAt: string | null;
  lastError: string | null;
}

export interface DeployTargetsView {
  targets: DeployTargetView[];
  inventorySeededAt: string | null;
}
