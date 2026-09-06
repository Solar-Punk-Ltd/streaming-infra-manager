import { Request, Response, Router } from 'express';

import type { OpenStreams } from '../../domain/auth/OpenStreams.js';
import {
  EventBus,
  MAX_EVENT_CLIENTS,
  ManagerEvent,
} from '../../domain/EventBus.js';
import { signedInSession } from '../middleware/requireSession.js';
import { endEventStream } from '../sse.js';

const HEARTBEAT_MS = 15_000;

export interface EventsRouter {
  router: Router;
  closeAll(): void;
}

export function createEventsRouter(
  bus: EventBus,
  openStreams: OpenStreams,
): EventsRouter {
  const router = Router();
  const active = new Set<Response>();

  router.get('/', (req: Request, res: Response) => {
    const session = signedInSession(req);

    if (bus.listenerCount() >= MAX_EVENT_CLIENTS) {
      res.status(503).json({ error: 'too many SSE clients' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers so EventSource's `onopen` fires immediately.
    res.write(': connected\n\n');

    const unsubscribe = bus.subscribe((event: ManagerEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat keeps proxies / load balancers from idling the connection,
    // and surfaces dead sockets so `close` fires and we clean up.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    active.add(res);
    const unregister = openStreams.open(
      session.tokenHash,
      session.user.id,
      () => endEventStream(res),
    );

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearInterval(heartbeat);

      unsubscribe();
      unregister();
      active.delete(res);
      res.end();
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return {
    router,
    closeAll(): void {
      for (const res of active) {
        endEventStream(res);
      }
      active.clear();
    },
  };
}
