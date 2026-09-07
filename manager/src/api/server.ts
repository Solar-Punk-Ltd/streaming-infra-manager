import http from 'node:http';

import express from 'express';

import { AuthService } from '../domain/auth/AuthService.js';
import { OpenStreams } from '../domain/auth/OpenStreams.js';
import { ChequebookService } from '../domain/ChequebookService.js';
import { ContainerControl } from '../domain/ContainerControl.js';
import { Database } from '../domain/Database.js';
import { DeployService } from '../domain/DeployService.js';
import { EngineConfigService } from '../domain/engineConfig/EngineConfigService.js';
import { EventBus } from '../domain/EventBus.js';
import { Logger } from '../domain/Logger.js';
import { MetricsCollector } from '../domain/MetricsCollector.js';
import { ProfileService } from '../domain/ProfileService.js';
import { StampService } from '../domain/StampService.js';
import { StackVersionService } from '../domain/versions/StackVersionService.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestLogger } from './middleware/requestLogger.js';
import { requireSameSite } from './middleware/requireSameSite.js';
import { createRequireSession } from './middleware/requireSession.js';
import { createActionsRouter } from './routes/actions.js';
import { createAuthRouter } from './routes/auth.js';
import { createChequebookRouter } from './routes/chequebook.js';
import { createConfigRouter } from './routes/config.js';
import { createEngineRouter } from './routes/engine.js';
import { createEngineConfigRouter } from './routes/engineConfig.js';
import { createEventsRouter } from './routes/events.js';
import { createGroupsRouter } from './routes/groups.js';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createStampRouter } from './routes/stamp.js';
import { createVersionsRouter } from './routes/versions.js';

const logger = Logger.getInstance();

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ApiDeps {
  database: Database;
  authService: AuthService;
  /** The same registry the auth service revokes through. */
  openStreams: OpenStreams;
  profileService: ProfileService;
  deployService: DeployService;
  stampService: StampService;
  chequebookService: ChequebookService;
  containerControl: ContainerControl;
  engineConfigService: EngineConfigService;
  stackVersionService: StackVersionService;
  eventBus: EventBus;
  metricsCollector: MetricsCollector;
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
  // Ahead of the body parser: a write from another site is refused before its
  // body is read, not after.
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));

  const events = createEventsRouter(deps.eventBus, deps.openStreams);
  const metrics = createMetricsRouter(deps.metricsCollector, deps.openStreams);
  const requireSession = createRequireSession(deps.authService);

  // Everything above this line is open, everything below it needs a session.
  // Docker's healthcheck reads /health, and /auth is where signing in happens.
  app.use('/health', createHealthRouter(deps.database));
  app.use('/auth', createAuthRouter(deps.authService, requireSession));
  app.use(requireSession);

  app.use(
    '/config',
    createConfigRouter(deps.chequebookService.floorBzz, () => deps.stackVersionService.hostPassphrase()),
  );
  app.use('/metrics', metrics);
  app.use('/events', events.router);
  app.use('/profiles', createProfilesRouter(deps.profileService));
  app.use('/groups', createGroupsRouter(deps.profileService));
  app.use('/versions', createVersionsRouter(deps.stackVersionService));
  app.use('/', createActionsRouter(deps.deployService));
  app.use('/', createStampRouter(deps.stampService));
  app.use('/', createChequebookRouter(deps.chequebookService));
  app.use('/', createEngineRouter(deps.profileService, deps.containerControl));
  app.use('/', createEngineConfigRouter(deps.engineConfigService));

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
