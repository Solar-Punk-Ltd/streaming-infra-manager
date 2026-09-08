import type { BeeNodeObservation, BeeNodeState } from '@streaming-infra-manager/common';

export interface BeeReadinessView {
  state: BeeNodeState | 'stale';
  label: string;
  detail: string;
}

const OBSERVATION_MAX_AGE_MS = 30_000;
const LABELS: Record<BeeNodeState, string> = {
  ready: 'Bee API ready',
  initializing: 'Bee initializing',
  unhealthy: 'Bee reports unhealthy',
  unreachable: 'Bee unreachable',
  unknown: 'Bee API not checked',
};
const DETAILS: Record<BeeNodeState, string> = {
  ready: 'Bee reports its API is ready. Receiving, uploading and playback have not been verified.',
  initializing: 'Bee reports notReady. No completion estimate is available. Retry the node checks or open its logs.',
  unhealthy: 'Bee reports an unhealthy probe. Open the Bee container logs to investigate.',
  unreachable: 'The node did not answer its API probes. Retry the node checks. Existing streams are left running.',
  unknown: 'The node did not supply complete, recognized API probe results. Retry the node checks.',
};

export function beeReadinessView(observation: BeeNodeObservation | null, now: number, refreshing: boolean, receivedAt: number | null): BeeReadinessView {
  if (!observation) return { state: 'unknown', label: 'Bee API not checked', detail: 'No current Bee API observation. Retry the node checks.' };
  const observedAt = Date.parse(observation.observedAt);
  const stale = refreshing || !Number.isFinite(observedAt) || receivedAt === null || !Number.isFinite(receivedAt) || receivedAt > now || now - receivedAt >= OBSERVATION_MAX_AGE_MS;
  if (stale) return { state: 'stale', label: 'Bee observation stale', detail: `Previous check: ${observation.observedAt}. Current node state is not verified. Retry the node checks.` };
  const progress = observation.chainProgress
    ? ` Bee reports chain block ${observation.chainProgress.block} of tip ${observation.chainProgress.chainTip}.`
    : '';
  return { state: observation.state, label: LABELS[observation.state], detail: `${DETAILS[observation.state]}${progress} Checked ${observation.observedAt}.` };
}
