import type { CreateProfileBody } from './interfaces';

export type ProfileKind = 'streamer' | 'viewer' | 'custom' | 'abr-uploader';

export type ProfileStatus =
  | 'DEPLOYING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'REMOVING'
  | 'ERROR';

export type UpdateProfileBody = Omit<CreateProfileBody, 'name' | 'host'>;
