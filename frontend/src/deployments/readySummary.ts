import type { StampHealth } from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import type { ChecklistInput } from './checklist';
import { isStreamLike, readinessOf } from './readiness';
import { hasService, isRunning, shapeOf } from './shape';

export interface ReadySummary {
  tone: Tone;
  title: string;
  url: string | null;
  /** The url opens in a browser rather than being pasted into an encoder. */
  isLink?: boolean;
}

export function readySummary(
  input: ChecklistInput,
  health?: StampHealth,
): ReadySummary {
  const { profile, publishUrl, clientUrl } = input;
  const readiness = readinessOf(profile, health);
  const shape = shapeOf(profile);

  if (isStreamLike(profile, shape) || shape === 'abr-uploader') {
    if (readiness.tone === 'ok' && publishUrl) {
      return {
        tone: 'ok',
        title: 'Ready. Point OBS or FFmpeg at this URL:',
        url: publishUrl,
      };
    }
    return {
      tone: readiness.tone,
      title:
        readiness.tone === 'gray'
          ? 'Stopped. Start it to get a publish URL.'
          : `Not ready yet: ${readiness.label.toLowerCase()}.`,
      url: null,
    };
  }

  if (shape === 'viewer' || hasService(profile, 'client')) {
    if (isRunning(profile) && clientUrl) {
      return {
        tone: 'ok',
        title: 'Watchable. Open the player:',
        url: clientUrl,
        isLink: true,
      };
    }
    return {
      tone: readiness.tone,
      title:
        readiness.tone === 'gray'
          ? 'Stopped. Start it to serve the player.'
          : 'Not watchable right now.',
      url: null,
    };
  }

  if (shape === 'bee-node') {
    return readiness.tone === 'ok'
      ? {
          tone: 'ok',
          title: 'This node is ready to receive uploads for its rung.',
          url: null,
        }
      : {
          tone: readiness.tone,
          title: `Not ready: ${readiness.label.toLowerCase()}.`,
          url: null,
        };
  }

  return isRunning(profile)
    ? { tone: 'ok', title: 'Running.', url: null }
    : { tone: readiness.tone, title: readiness.label, url: null };
}
