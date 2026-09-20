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
const STALE_AFTER_MS = 30_000;
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
  if (!isRecord(raw) || raw.lifecycleVersion !== 1 || typeof raw.observedAt !== 'string' || !Array.isArray(raw.streams)) return UNAVAILABLE;
  const observedAt = Date.parse(raw.observedAt);
  if (!Number.isFinite(observedAt)) return UNAVAILABLE;
  const streams: UploaderLifecycleStream[] = [];
  for (const rawStream of raw.streams) {
    const stream = parseStream(rawStream, observedAt, receivedAt);
    if (!stream) return UNAVAILABLE;
    streams.push(stream);
  }
  return { state: 'available', streams };
}

function parseStream(raw: unknown, observedAt: number, receivedAt: Date): UploaderLifecycleStream | null {
  if (!isRecord(raw) || typeof raw.adminStreamId !== 'string' || !isUuid(raw.adminStreamId) || !Number.isInteger(raw.runNumber) || raw.runNumber < 1 || typeof raw.state !== 'string' || typeof raw.lastObservedAt !== 'string') return null;
  if (!ACTIVE_STATES.has(raw.state as UploaderLifecycleState) && !TERMINAL_STATES.has(raw.state as UploaderLifecycleState)) return null;
  const lastObservedAt = Date.parse(raw.lastObservedAt);
  if (!Number.isFinite(lastObservedAt) || observedAt < lastObservedAt || observedAt > receivedAt.getTime()) return null;
  const state = raw.state as UploaderLifecycleState;
  if (ACTIVE_STATES.has(state) && observedAt - lastObservedAt > STALE_AFTER_MS) return null;
  return { adminId: raw.adminStreamId, runNumber: raw.runNumber, state };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
