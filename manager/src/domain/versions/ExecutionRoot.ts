import { isAbsolute, join, resolve } from 'node:path';
import type { ProfileStatus } from '../../types/index.js';
import { buildIdProblem } from './buildManifest.js';

export interface ExecutionSource {
  versionId: number;
  buildId: string;
  commit: string;
  root: string;
  artifactDigest: string;
}
export interface ExecutionRootRegistration {
  executionId: string;
  source: ExecutionSource;
  profile: { name: string; instanceId: string; intentRevision: number; status: ProfileStatus };
  jobReferenceId: number;
  target: { alias: string; daemonId: string };
  action: 'deploy' | 'stop' | 'remove' | 'health';
  services: string[];
}
export type ExecutionRootState = 'registered' | 'copying' | 'ready' | 'launch-uncertain' | 'deleting' | 'released';
export interface ExecutionRootRecord extends ExecutionRootRegistration {
  project: string;
  root: string;
  state: ExecutionRootState;
  copyToken: string | null;
  referenceId: number;
  createdAt: Date;
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function assertExecutionId(id: string): void {
  if (!UUID.test(id)) throw new Error('Invalid execution identity.');
}
export function executionRootPath(parent: string, id: string): string {
  assertExecutionId(id);
  if (!isAbsolute(parent) || resolve(parent) !== parent) throw new Error('Executions parent must be a normalized absolute path.');
  return join(parent, id, 'tree');
}
export function assertExecutionRegistration(input: ExecutionRootRegistration): void {
  assertExecutionId(input.executionId);
  assertExecutionId(input.profile.instanceId);
  if (!Number.isSafeInteger(input.source.versionId) || input.source.versionId < 1 ||
      !Number.isSafeInteger(input.jobReferenceId) || input.jobReferenceId < 1 ||
      !Number.isSafeInteger(input.profile.intentRevision) || input.profile.intentRevision < 0 ||
      buildIdProblem(input.source.buildId) || !/^[a-f0-9]{7,40}$/.test(input.source.commit) ||
      !/^[a-f0-9]{64}$/.test(input.source.artifactDigest) || !isAbsolute(input.source.root) || resolve(input.source.root) !== input.source.root ||
      !/^[a-z0-9][a-z0-9-]{0,30}$/.test(input.profile.name) || !input.target.daemonId.trim() ||
      !['deploy', 'stop', 'remove', 'health'].includes(input.action) ||
      !['DEPLOYING', 'RUNNING', 'STOPPING', 'STOPPED', 'REMOVING', 'ERROR'].includes(input.profile.status) ||
      !Array.isArray(input.services) || new Set(input.services).size !== input.services.length ||
      input.services.some(service => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(service))) {
    throw new Error('Invalid execution ownership descriptor.');
  }
}
