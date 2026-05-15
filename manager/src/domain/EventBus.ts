import { EventEmitter } from 'node:events';

import { Profile } from '../types.js';

/**
 * Profile-scoped event payloads broadcast to interested subscribers
 * (currently the /events SSE stream). `changed` carries the full row so
 * consumers can patch state without a follow-up GET; `deleted` only needs
 * the key.
 */
export type ProfileEvent =
  | { type: 'profile.changed'; profile: Profile }
  | { type: 'profile.deleted'; name: string };

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: ProfileEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ProfileEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
