import { EventEmitter } from 'node:events';

import { ProfileWithContainers } from '../types/index.js';

export type ProfileEvent =
  | { type: 'profile.changed'; profile: ProfileWithContainers }
  | { type: 'profile.deleted'; name: string };

export const MAX_EVENT_CLIENTS = 100;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(MAX_EVENT_CLIENTS);
  }

  publish(event: ProfileEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ProfileEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}
