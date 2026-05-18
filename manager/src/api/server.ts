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
import { createHealthRouter } from './routes/health.js';
import { createProfilesRouter } from './routes/profiles.js';

const logger = Logger.getInstance();

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

  app.use('/health', createHealthRouter(deps.database));
  app.use('/events', createEventsRouter(deps.eventBus));
  app.use('/profiles', createProfilesRouter(deps.profileService));
  app.use('/', createActionsRouter(deps.deployService));

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, host, () => {
    logger.info(`[ApiServer] Listening on ${host}:${port}`);
  });

  return {
    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            logger.info('[ApiServer] Server closed');
            resolve();
          }
        });
      });
    },
  };
}
