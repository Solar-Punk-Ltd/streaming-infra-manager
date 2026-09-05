import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import type { WizardGoal } from './wizardState';

export interface GoalCard {
  id: WizardGoal;
  title: string;
  detail: string;
  services: string[];
}

export const GOALS: GoalCard[] = [
  {
    id: 'stream',
    title: 'Stream to Swarm',
    detail: 'Take a live feed from OBS or FFmpeg and publish it to Swarm.',
    services: [SRS_SERVICE, STREAM_UPLOADER_SERVICE, BEE_UPLOADER_SERVICE],
  },
  {
    id: 'viewer',
    title: 'Watch a stream',
    detail: 'A web player for one stream, served through a Swarm gateway.',
    services: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
  },
  {
    id: 'abr-pool',
    title: 'ABR node pool',
    detail:
      'Four Bee nodes, one per quality (360p to 1080p), as upload targets for an ABR uploader.',
    services: [`${BEE_UPLOADER_SERVICE} ×4`],
  },
  {
    id: 'abr-uploader',
    title: 'ABR uploader',
    detail:
      'Ingest and encode a quality ladder, publishing to a node pool. No Bee node of its own.',
    services: [SRS_SERVICE, STREAM_UPLOADER_SERVICE],
  },
  {
    id: 'custom',
    title: 'Custom',
    detail: 'Pick the components yourself. For experiments.',
    services: [],
  },
];

/** Every service the custom form offers, in the order it lists them. */
export const CUSTOM_COMPONENTS: string[] = [
  SRS_SERVICE,
  OME_SERVICE,
  STREAM_UPLOADER_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  BEE_GATEWAY_SERVICE,
];

/** What a custom deployment starts ticked with: an engine and a player. */
export const DEFAULT_CUSTOM_COMPONENTS: string[] = [
  SRS_SERVICE,
  CLIENT_SERVICE,
  BEE_GATEWAY_SERVICE,
];
