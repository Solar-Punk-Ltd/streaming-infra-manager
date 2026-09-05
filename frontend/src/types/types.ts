export type ProfileKind = 'streamer' | 'viewer' | 'custom' | 'abr-uploader';

export type ProfileStatus =
  | 'DEPLOYING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'REMOVING'
  | 'ERROR';
