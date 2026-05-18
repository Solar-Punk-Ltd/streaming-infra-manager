import { Request, Response, Router } from 'express';

import {
  EventBus,
  MAX_EVENT_CLIENTS,
  ProfileEvent,
} from '../../domain/EventBus.js';

const HEARTBEAT_MS = 15_000;

export function createEventsRouter(bus: EventBus): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
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

    const unsubscribe = bus.subscribe((event: ProfileEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat keeps proxies / load balancers from idling the connection,
    // and surfaces dead sockets so `close` fires and we clean up.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearInterval(heartbeat);

      unsubscribe();
      res.end();
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
