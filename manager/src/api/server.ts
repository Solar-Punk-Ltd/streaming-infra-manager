import http from 'node:http';

import express from 'express';

import { Database } from '../domain/Database.js';
import { DeployService } from '../domain/DeployService.js';
import { EventBus } from '../domain/EventBus.js';
import { Logger } from '../domain/Logger.js';
import { ProfileService } from '../domain/ProfileService.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createActionsRouter } from './routes/actions.js';
import { createEventsRouter } from './routes/events.js';
import { createGroupsRouter } from './routes/groups.js';
import { createHealthRouter } from './routes/health.js';
import { createProfilesRouter } from './routes/profiles.js';

const logger = Logger.getInstance();

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ApiDeps {
  database: Database;
  profileService: ProfileService;
  deployService: DeployService;
  eventBus: EventBus;
}

export interface ApiServerHandle {
  close(): Promise<void>;
}

export function startApiServer(
  deps: ApiDeps,
  port: number,
  host: string,
): ApiServerHandle {
  const app = express();

  app.use(requestLogger);
  app.use(express.json({ limit: '256kb' }));

  const events = createEventsRouter(deps.eventBus);

  app.use('/health', createHealthRouter(deps.database));
  app.use('/events', events.router);
  app.use('/profiles', createProfilesRouter(deps.profileService));
  app.use('/groups', createGroupsRouter(deps.profileService));
  app.use('/', createActionsRouter(deps.deployService));

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, host, () => {
    logger.info(`[ApiServer] Listening on ${host}:${port}`);
  });

  return {
    async close() {
      events.closeAll();

      return new Promise<void>((resolve, reject) => {
        const forceTimer = setTimeout(() => {
          logger.warn(
            `[ApiServer] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing close`,
          );
          server.closeAllConnections?.();
        }, SHUTDOWN_TIMEOUT_MS);

        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) {
            reject(err);
          } else {
            logger.info('[ApiServer] Server closed');
            resolve();
          }
        });
      });
    },
  };
}
