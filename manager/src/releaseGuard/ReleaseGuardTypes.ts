export const RELEASE_GUARD_SCHEMA_VERSION = 1;
export const RELEASE_GUARD_MINIMUM = Object.freeze({ srsLifecycle: 1 as const });

export type ReleaseRole = 'manager' | 'admin' | 'uploader' | 'viewer';

export interface ReleaseSlot {
  role: ReleaseRole;
  id: string;
}

export interface ComposeReleaseTarget {
  projectName: string;
  postgresVolumeName: string;
  webPort: number;
}

export interface ManagerReleaseTarget extends ComposeReleaseTarget {
  mode: 'production' | 'isolated';
  postgresPort: number;
}

export interface ReleaseImage {
  service: string;
  imageId: string;
}

export interface ReleaseArtifact {
  treeDigest: string;
  images: ReleaseImage[];
}

export interface ReleaseGuardReceipt {
  schemaVersion: 1;
  installationId: string;
  generation: number;
  stateDigest: string;
  slot: ReleaseSlot;
  minimums: { srsLifecycle: 1 };
  artifact: ReleaseArtifact;
}

export interface StoredReleaseSlot {
  minimums: { srsLifecycle: 1 };
  artifact: ReleaseArtifact;
}

export interface ReleaseGuardState {
  schemaVersion: 1;
  installationId: string;
  generation: number;
  slots: Record<string, StoredReleaseSlot>;
  attempt: ReleaseGuardAttempt | null;
}

export interface ReleaseGuardAttempt {
  phase: 'prepared' | 'verified';
  receipt: ReleaseGuardReceipt;
  body: string;
}

export interface PendingReleaseReceipt {
  receipt: ReleaseGuardReceipt;
  body: string;
}

export interface ActiveArtifactMetadata {
  schemaVersion: 1;
  installationId: string;
  generation: number;
  slot: ReleaseSlot;
  artifact: ReleaseArtifact;
}
