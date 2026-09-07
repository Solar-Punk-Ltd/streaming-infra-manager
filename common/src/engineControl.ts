/**
 * The engine control facts the manager, the UI and the offline mock all have to
 * agree on, word for word.
 */
import {
  BEE_UPLOADER_SERVICE,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from './constants.js';
import type { EngineDefaultSources } from './engineDefaults.js';
import type {
  EngineSettingField,
  EngineSettings,
} from './engineSettings.js';
import type { EngineName } from './engines.js';
import type { StackContractFeatures } from './stackVersions.js';

/**
 * The containers an operator has a reason to bounce on their own: the media
 * server when its settings changed or its ingest wedged, the uploader when it
 * stopped publishing, and the Bee node when it stopped answering. The web
 * player and the gateway have no state worth clearing, so they are restarted by
 * redeploying.
 */
export const RESTARTABLE_SERVICES: readonly string[] = [
  SRS_SERVICE,
  OME_SERVICE,
  STREAM_UPLOADER_SERVICE,
  BEE_UPLOADER_SERVICE,
];

/**
 * Why the Engine card cannot show what is publishing right now.
 *
 * Both engines have an API that would answer it and neither is reachable on the
 * stack this manager is pinned to: SRS's listens on 1985 inside the container
 * and the compose file publishes no such port, and OvenMediaEngine's needs a
 * `<Managers>` block the template does not carry. Sent as text rather than a
 * flag, because "not available" with no reason is the least useful thing a
 * card can say.
 */
export const LIVE_UNAVAILABLE_REASON: Record<EngineName, string> = {
  [SRS_SERVICE]:
    'Live status needs the SRS API port, which this stack version does not publish.',
  [OME_SERVICE]:
    'Live status needs the OvenMediaEngine API, which this stack version does not enable.',
};

const SRS_API_NOT_READ_YET =
  'This stack version publishes the SRS API port. Reading live status from it is not built into the manager yet.';

/**
 * Why the Engine card cannot show what is publishing right now, on the version
 * this deployment runs. A version that publishes the port is told the truth,
 * which is that the manager does not read it yet, rather than that the port
 * is not there.
 */
export function liveUnavailableReason(
  engine: EngineName,
  features: StackContractFeatures | null | undefined,
): string {
  if (engine === SRS_SERVICE && features?.srsApiPort) {
    return SRS_API_NOT_READ_YET;
  }
  return LIVE_UNAVAILABLE_REASON[engine];
}

/** What the manager knows about a deployment's engine without asking Docker. */
export interface EngineSettingsOverview {
  engine: EngineName;
  /** This deployment encodes the ABR ladder, so the transcoding fields apply. */
  abr: boolean;
  /** Only the keys this deployment overrides. Absent means the default below. */
  settings: EngineSettings;
  /**
   * What an unset key falls back to on the host this deployment runs on, which
   * is the stack's own value unless the host's base `.env` sets it.
   */
  defaults: EngineSettings;
  defaultSources: EngineDefaultSources;
  fields: readonly EngineSettingField[];
  /** Why live status is not shown, in words the card can show as it stands. */
  liveUnavailableReason: string;
}

/** What `GET /profiles/:name/engine` answers. */
export interface EngineOverview extends EngineSettingsOverview {
  /**
   * What is publishing right now. Always null for now: the manager does not
   * read the engine API yet, whether or not the version publishes its port.
   */
  live: null;
}

/**
 * The words that separate "the container is not up" from every other reason a
 * read failed.
 *
 * The UI has only the message to go on: the logs and the config routes answer
 * text, so a failure reaches the browser as a sentence and not as a code. Both
 * ends take the phrase from here, so the check cannot drift away from the
 * sentence it is checking for.
 */
const NOT_RUNNING_PHRASE = 'container is running for';

export function containerNotRunningMessage(
  profileName: string,
  service: string,
): string {
  return (
    `No ${service} ${NOT_RUNNING_PHRASE} ${profileName}. ` +
    'Start the deployment, then try again.'
  );
}

/** Whether a failed read failed because the container is not up. */
export function saysContainerNotRunning(message: string): boolean {
  return message.includes(NOT_RUNNING_PHRASE);
}
