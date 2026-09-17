import {
  getErrorMessage,
  STREAM_UPLOADER_SERVICE,
  UPLOADER_HEALTH_NOT_DEPLOYED,
  UPLOADER_HEALTH_OK,
  UPLOADER_HEALTH_UNHEALTHY,
  UPLOADER_HEALTH_UNREACHABLE,
  UPLOADER_HEALTH_WAITING_FOR_NODE,
  UPLOADER_HEALTH_WARNED,
  type UploaderHealthReading,
  type UploaderNodeWait,
  type UploaderStartGateWarning,
} from '@streaming-infra-manager/common';

import { Profile } from '../types/index.js';
import { resolveNetworkHost } from '../utils/deployHost.js';

import { ContainerRepository } from './ContainerRepository.js';
import { ProfileNotFoundError } from './errors/index.js';
import { LOCAL_DEPLOY_TARGETS, LOCAL_PUBLISHED_HOST } from './localHost.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { portFor, portTableOf } from './versions/portTable.js';
import type { StackVersionRepository } from './versions/StackVersionRepository.js';

const logger = Logger.getInstance();

/** The uploader's own HTTP API in every version's port table, and `API_PORT` in its compose file. */
const UPLOADER_API_PORT_VAR = 'API_PORT';

/**
 * The same budget the node probes get, and for the same reason: this is read on
 * a page load and repeated on a cadence, so an uploader that has stopped
 * answering must not hold the page.
 */
const READ_BUDGET_MS = 3_000;

/** No reason reaches the page beyond what the uploader would plausibly report. */
const MAX_REASONS = 20;
const MAX_WARNINGS = 12;
const MAX_TEXT = 500;

/** Takes the request, so a test can answer without a listening socket. */
export type UploaderHealthFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Response>;

const NOTHING_REPORTED: string[] = [];

/**
 * What one deployment's stream-uploader says about itself.
 *
 * Decision D16, the owner on 2026-09-17, lets an uploader start on a Bee node
 * that is not answering. The uploader then waits for that node rather than
 * exiting, so "started" stopped meaning "working" and the difference is only
 * visible on the uploader's own `/health`. This is the read of it, in the one
 * shape the deployment page renders.
 *
 * Never throws for a reading. Nothing answering is an answer here, because the
 * page asks on a cadence and an exception would turn a container that is still
 * coming up into an error banner. An unknown deployment still throws, since
 * that is about the request rather than about the uploader.
 */
export class UploaderHealthService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly versions: StackVersionRepository,
    private readonly fetchHealth: UploaderHealthFetch = (url, init) =>
      fetch(url, init),
  ) {}

  async read(name: string): Promise<UploaderHealthReading> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);

    const containers = await this.containers.listApiContainers(name);
    const deployed = containers.some(
      (container) => container.service === STREAM_UPLOADER_SERVICE,
    );
    if (!deployed) {
      return { state: UPLOADER_HEALTH_NOT_DEPLOYED, reasons: NOTHING_REPORTED };
    }

    const url = await this.healthUrlFor(profile);
    if (!url) return { state: UPLOADER_HEALTH_UNREACHABLE, reasons: NOTHING_REPORTED };

    try {
      const response = await this.fetchHealth(url, {
        signal: AbortSignal.timeout(READ_BUDGET_MS),
      });
      const body: unknown = await response.json();
      return readingFrom(response.ok, body);
    } catch (err) {
      logger.debug(
        `[UploaderHealthService] ${name}: ${url} did not answer (${getErrorMessage(err)})`,
      );
      return { state: UPLOADER_HEALTH_UNREACHABLE, reasons: NOTHING_REPORTED };
    }
  }

  /**
   * Where this deployment's uploader publishes its API, or null when the
   * version it runs declares no such port.
   *
   * The host resolution is `beeApiUrlFor`'s: a deploy target that names this
   * machine is reached the way every published port here is, through
   * LOCAL_PUBLISHED_HOST, and a declared remote host keeps its own address with
   * the ssh layer resolved away.
   */
  private async healthUrlFor(profile: Profile): Promise<string | null> {
    const version = await this.versions.findById(profile.stack_version_id);
    const port = portTableOf(version?.contract).find(
      (entry) => entry.name === UPLOADER_API_PORT_VAR,
    );
    if (!port) {
      logger.warn(
        `[UploaderHealthService] ${profile.name}: its stack version declares no ${UPLOADER_API_PORT_VAR}, ` +
          'so its uploader health cannot be read.',
      );
      return null;
    }

    const declared = resolveNetworkHost((profile.host ?? '').trim());
    const host = LOCAL_DEPLOY_TARGETS.has(declared) ? LOCAL_PUBLISHED_HOST : declared;
    return `http://${host}:${portFor(port, profile.port_slot)}/health`;
  }
}

/**
 * The uploader's payload as one state.
 *
 * Read off the payload's own `status` and `reasons` before the HTTP code,
 * because the code cannot tell the two 503s apart: a service still waiting for
 * its node has run nothing and reported nothing, while a degraded one is
 * running and has something to say. A stack older than the pin answers neither
 * the waiting status nor the warnings and falls through to ok or unhealthy on
 * its HTTP code alone, which is what "no waiting state reported" has to mean.
 * The pinned stack answers both.
 */
function readingFrom(ok: boolean, body: unknown): UploaderHealthReading {
  const payload = (body ?? {}) as Record<string, unknown>;
  const reasons = textsOf(payload.reasons, MAX_REASONS);
  const warnings = startGateWarningsOf(payload.startGateWarnings);

  if (payload.status === UPLOADER_HEALTH_WAITING_FOR_NODE || reasons.includes('node_unavailable')) {
    const waitingSince = textOf(payload.waitingSince);
    const node = nodeWaitOf(payload.node);
    return {
      state: UPLOADER_HEALTH_WAITING_FOR_NODE,
      reasons,
      ...(waitingSince === null ? {} : { waitingSince }),
      ...(node === null ? {} : { node }),
    };
  }

  if (ok) return { state: UPLOADER_HEALTH_OK, reasons };

  const warnedOnly =
    reasons.length > 0 && reasons.every((reason) => reason === 'start_gate_warned');
  return {
    state: warnedOnly ? UPLOADER_HEALTH_WARNED : UPLOADER_HEALTH_UNHEALTHY,
    reasons,
    ...(warnings.length === 0 ? {} : { startGateWarnings: warnings }),
  };
}

function nodeWaitOf(raw: unknown): UploaderNodeWait | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  const url = textOf(node.url);
  if (url === null) return null;
  const lastError = textOf(node.lastError);
  return {
    url,
    attempts: typeof node.attempts === 'number' && Number.isFinite(node.attempts)
      ? node.attempts
      : 0,
    ...(lastError === null ? {} : { lastError }),
  };
}

function startGateWarningsOf(raw: unknown): UploaderStartGateWarning[] {
  if (!Array.isArray(raw)) return [];
  const warnings: UploaderStartGateWarning[] = [];
  for (const entry of raw.slice(0, MAX_WARNINGS)) {
    if (!entry || typeof entry !== 'object') continue;
    const warning = entry as Record<string, unknown>;
    const gate = textOf(warning.gate);
    if (gate === null) continue;
    const rung = textOf(warning.rung);
    warnings.push({ gate, ...(rung === null ? {} : { rung }) });
  }
  return warnings;
}

/**
 * One string off the payload, bounded.
 *
 * The uploader is this manager's own deployment rather than a caller, so this
 * is not a trust boundary in the usual sense, but every one of these strings is
 * rendered on a page and none of them has a reason to be long.
 */
function textOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

function textsOf(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, limit)
    .map((entry) => textOf(entry))
    .filter((entry): entry is string => entry !== null);
}
