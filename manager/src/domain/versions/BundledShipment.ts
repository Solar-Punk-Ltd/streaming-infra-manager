import type { StackContract } from '@streaming-infra-manager/common';
import type { BuildManifest } from './buildManifest.js';

export interface BundledShipmentReceipt {
  shipmentId: string;
  versionId: number;
  buildId: string;
  publicationRevision: string;
  publishedAt: Date;
}
export interface BundledShipmentRecord {
  shipmentId: string;
  versionId: number;
  packageDigest: string;
  commitSha: string;
  expectedRevision: string;
  rootPath: string;
  state: 'registered' | 'prepared' | 'published' | 'superseded';
  candidateBuildId: string | null;
  candidateKind: 'new' | 'reuse' | null;
  candidateManifest: BuildManifest | null;
  artifactDigest: string | null;
  candidateContract: StackContract | null;
  receipt: BundledShipmentReceipt | null;
  createdAt: Date;
}
export interface BundledCandidateProposal { buildId: string; kind: 'new' | 'reuse'; manifest: BuildManifest }
export interface PreparedBundledCandidate { artifactDigest: string; contract: StackContract }
export type BundledActivation =
  | { status: 'published'; receipt: BundledShipmentReceipt }
  | { status: 'superseded'; shipmentId: string };
