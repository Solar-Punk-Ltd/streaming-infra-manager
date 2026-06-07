import { Request, Response, Router } from 'express';

import { MetricsCollector } from '../../domain/MetricsCollector.js';

const HEARTBEAT_MS = 15_000;
const MAX_METRICS_CLIENTS = 50;

/**
 * Resource-metrics endpoints.
 *
 *   GET /metrics         → latest snapshot as JSON (one-shot, for initial paint)
 *   GET /metrics/stream  → Server-Sent Events, one `snapshot` event per sample
 *
 * Both are testable without the frontend:
 *   curl localhost:9876/metrics | jq
 *   curl -N localhost:9876/metrics/stream
 */
export function createMetricsRouter(collector: MetricsCollector): Router {
  const router = Router();
  let clientCount = 0;

  router.get('/', (_req: Request, res: Response) => {
    const snapshot = collector.getLatest();
    if (!snapshot) {
      // No sample taken yet — kick off sampling so the next request has data.
      const unsubscribe = collector.subscribe(() => undefined);
      unsubscribe();
      res.status(503).json({ error: 'metrics not ready yet, retry shortly' });
      return;
    }
    res.json(snapshot);
  });

  router.get('/stream', (_req: Request, res: Response) => {
    if (clientCount >= MAX_METRICS_CLIENTS) {
      res.status(503).json({ error: 'too many metrics clients' });
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

    clientCount += 1;

    // subscribe() pushes the current snapshot immediately (if any), then every
    // new sample. It also starts/stops the collector's sampling for us.
    const unsubscribe = collector.subscribe((snapshot) => {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      clientCount -= 1;
      res.end();
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
