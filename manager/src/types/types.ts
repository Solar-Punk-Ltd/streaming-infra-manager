import { ALL_SERVICES, PROFILE_KINDS, PROFILE_STATUSES } from './constants.js';

export type ProfileKind = (typeof PROFILE_KINDS)[number];

export type ServiceName = (typeof ALL_SERVICES)[number];

export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export type ActionKind = 'deploy' | 'stop' | 'clean' | 'health';

export function isService(s: string): s is ServiceName {
  return (ALL_SERVICES as readonly string[]).includes(s);
}
