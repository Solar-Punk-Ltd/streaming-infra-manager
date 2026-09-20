import {
  STREAM_UPLOADER_SERVICE,
  type UploaderLifecycleReading,
  type UploaderLifecycleState,
  type UploaderLifecycleStream,
} from '@streaming-infra-manager/common';

import { ContainerRepository } from './ContainerRepository.js';
import { ContainerControl } from './ContainerControl.js';
import { ProfileNotFoundError } from './errors/index.js';
import { ProfileRepository } from './ProfileRepository.js';
import type { StackVersionRepository } from './versions/StackVersionRepository.js';
import { isLocalTarget } from './ports/DeployTargets.js';

const ACTIVE_STATES = new Set<UploaderLifecycleState>(['ready', 'claimed', 'live', 'waiting']);
const TERMINAL_STATES = new Set<UploaderLifecycleState>(['closed', 'vod']);
const CLOSE_REASONS = new Set([
  'reconnect_timeout',
  'cancelled',
  'recovery_required',
  'finalization_failed',
  'empty',
]);
const PERMISSION_BY_STATE: Record<UploaderLifecycleState, string> = {
  ready: 'open',
  claimed: 'claimed',
  live: 'claimed',
  waiting: 'claimed',
  closed: 'closed',
  vod: 'closed',
};
const STALE_AFTER_MS = 30_000;
const MAX_STREAMS = 100;
const MAX_STREAM_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;
const UNAVAILABLE: UploaderLifecycleReading = { state: 'unavailable' };

/** Reads and narrows the uploader's private lifecycle endpoint for the deployment page. */
export class UploaderLifecycleService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly versions: StackVersionRepository,
    private readonly control: ContainerControl,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(name: string): Promise<UploaderLifecycleReading> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    if (!isLocalTarget(profile.host) || !(await this.hasUploader(name))) return UNAVAILABLE;
    const version = await this.versions.findById(profile.stack_version_id);
    if (!version?.contract?.features.srsLifecycleV1) return UNAVAILABLE;
    try {
      return lifecycleReading(JSON.parse(await this.control.uploaderLifecycle(name)), this.now());
    } catch {
      return UNAVAILABLE;
    }
  }

  private async hasUploader(name: string): Promise<boolean> {
    return (await this.containers.listApiContainers(name)).some(entry => entry.service === STREAM_UPLOADER_SERVICE);
  }
}

export function lifecycleReading(raw: unknown, receivedAt: Date): UploaderLifecycleReading {
  if (
    !isRecord(raw) ||
    raw.lifecycleVersion !== 1 ||
    !isTimestamp(raw.observedAt) ||
    !Array.isArray(raw.streams) ||
    raw.streams.length > MAX_STREAMS
  ) {
    return UNAVAILABLE;
  }
  const observedAt = Date.parse(raw.observedAt);
  const streams: UploaderLifecycleStream[] = [];
  for (const rawStream of raw.streams) {
    const stream = parseStream(rawStream, observedAt, receivedAt);
    if (!stream) return UNAVAILABLE;
    streams.push(stream);
  }
  return { state: 'available', streams };
}

function parseStream(
  raw: unknown,
  observedAt: number,
  _receivedAt: Date,
): UploaderLifecycleStream | null {
  if (
    !isRecord(raw) ||
    typeof raw.streamId !== 'string' ||
    raw.streamId.length === 0 ||
    raw.streamId.length > MAX_STREAM_ID_LENGTH ||
    typeof raw.adminStreamId !== 'string' ||
    !isUuid(raw.adminStreamId) ||
    !Number.isSafeInteger(raw.runNumber) ||
    Number(raw.runNumber) < 1 ||
    typeof raw.state !== 'string' ||
    !isTimestamp(raw.lastObservedAt)
  ) {
    return null;
  }
  if (
    !ACTIVE_STATES.has(raw.state as UploaderLifecycleState) &&
    !TERMINAL_STATES.has(raw.state as UploaderLifecycleState)
  ) {
    return null;
  }
  const state = raw.state as UploaderLifecycleState;
  if (raw.permission !== PERMISSION_BY_STATE[state]) return null;
  if (!hasStateFields(raw, state)) return null;

  const lastObservedAt = Date.parse(raw.lastObservedAt);
  const initialAgeMs = observedAt - lastObservedAt;
  if (initialAgeMs < 0) return null;
  if (ACTIVE_STATES.has(state) && initialAgeMs > STALE_AFTER_MS) return null;
  return {
    adminId: raw.adminStreamId,
    runNumber: Number(raw.runNumber),
    state,
    initialAgeMs,
  };
}

function hasStateFields(
  raw: Record<string, unknown>,
  state: UploaderLifecycleState,
): boolean {
  if (state === 'waiting') {
    return isTimestamp(raw.reconnectDeadline) && raw.closeReason === undefined;
  }
  if (state === 'closed') {
    return (
      typeof raw.closeReason === 'string' &&
      CLOSE_REASONS.has(raw.closeReason) &&
      raw.reconnectDeadline === undefined
    );
  }
  return raw.reconnectDeadline === undefined && raw.closeReason === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
