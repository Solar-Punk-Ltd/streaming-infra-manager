import { EventEmitter } from 'node:events';

import { ProfileWithContainers } from '../types.js';

export type ProfileEvent =
  | { type: 'profile.changed'; profile: ProfileWithContainers }
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
