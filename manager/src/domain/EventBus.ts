import { EventEmitter } from 'node:events';

import { ProfileWithContainers } from '../types/index.js';

/** How loud a notice is, in the three levels the UI already renders. */
export type NoticeTone = 'info' | 'warn' | 'err';

export type ProfileEvent =
  | { type: 'profile.changed'; profile: ProfileWithContainers }
  | { type: 'profile.deleted'; name: string }
  /**
   * Something that happened to a deployment which changes nothing about it, and
   * which an operator would otherwise only find by reading the manager's log.
   * `profile` is the name it happened to and `text` is the whole sentence.
   */
  | {
      type: 'profile.notice';
      profile: string;
      text: string;
      tone: NoticeTone;
    }
  /**
   * One container was restarted on its own. It carries no profile, because a
   * restart happens below the deploy state machine and changes no status: the
   * deployment is running before and after, so there is nothing for a status
   * pill to show and this exists to appear in the activity list.
   */
  | { type: 'engine.restarted'; profile: string; service: string };

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
