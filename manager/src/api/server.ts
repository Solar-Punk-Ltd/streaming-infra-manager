import type { ChequebookOperationsService } from '../domain/chequebook/ChequebookOperationsService.js';
import http from 'node:http';

import express from 'express';

import { AuthService } from '../domain/auth/AuthService.js';
import { OpenStreams } from '../domain/auth/OpenStreams.js';
import { ChequebookService } from '../domain/ChequebookService.js';
import { ContainerControl } from '../domain/ContainerControl.js';
import { Database } from '../domain/Database.js';
import { DeployService } from '../domain/DeployService.js';
import { EngineConfigService } from '../domain/engineConfig/EngineConfigService.js';
import type { AdminLinkTester } from '../domain/adminLink/AdminLinkTester.js';
import type { ManagerAdminLinkService } from '../domain/adminLink/ManagerAdminLinkService.js';
import type { DeploymentSettingsService } from '../domain/settings/DeploymentSettingsService.js';
import { EventBus } from '../domain/EventBus.js';
import { Logger } from '../domain/Logger.js';
import { MetricsCollector } from '../domain/MetricsCollector.js';
import { ProfileService } from '../domain/ProfileService.js';
import { SrtIngestHealthService } from '../domain/srtIngest/SrtIngestHealthService.js';
import { StampService } from '../domain/StampService.js';
import { UploaderHealthService } from '../domain/UploaderHealthService.js';
import { StackVersionService } from '../domain/versions/StackVersionService.js';
import type { DeploymentOrchestrator } from '../domain/DeploymentOrchestrator.js';
import type { VerifiedDeployTargets } from '../domain/ports/VerifiedDeployTargets.js';
import type { FirewallInventoryExporter } from '../domain/ports/FirewallInventoryExporter.js';
import type { PortReservationRepository } from '../domain/ports/PortReservationRepository.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestLogger } from './middleware/requestLogger.js';
import { requireSameSite } from './middleware/requireSameSite.js';
import { createRequireSession } from './middleware/requireSession.js';
import { createActionsRouter } from './routes/actions.js';
import { createAdminLinkTestRouter } from './routes/adminLinkTest.js';
import { createAuthRouter } from './routes/auth.js';
import { createChequebookRouter } from './routes/chequebook.js';
import { createConfigRouter } from './routes/config.js';
import { createDeploymentSettingsRouter } from './routes/deploymentSettings.js';
import { createEngineRouter } from './routes/engine.js';
import { createEngineConfigRouter } from './routes/engineConfig.js';
import { createEventsRouter } from './routes/events.js';
import { createGroupsRouter } from './routes/groups.js';
import { createHealthRouter } from './routes/health.js';
import { createManagerSettingsRouter } from './routes/managerSettings.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createSrtIngestRouter } from './routes/srtIngest.js';
import { createSrtPassphraseRouter } from './routes/srtPassphrase.js';
import { createStampRouter } from './routes/stamp.js';
import { createAttemptsRouter } from './routes/attempts.js';
import { createVersionsRouter } from './routes/versions.js';
import { createTargetsRouter } from './routes/targets.js';
import type { PortInventory } from '../domain/ports/PortInventory.js';

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
  chequebookOperations: ChequebookOperationsService;
  uploaderHealthService: UploaderHealthService;
  srtIngestHealthService: SrtIngestHealthService;
  containerControl: ContainerControl;
  engineConfigService: EngineConfigService;
  deploymentSettingsService: DeploymentSettingsService;
  /** The web2 admin link every new uploader deployment starts with, which the Manager settings page edits. */
  managerAdminLinkService: ManagerAdminLinkService;
  /** Test connection, for an address typed on a page and for what a deployment's next deploy gives its uploader. */
  adminLinkTester: AdminLinkTester;
  stackVersionService: StackVersionService;
  /** For the deploy attempts that hold a project or the daemon, and their release. */
  orchestrator: DeploymentOrchestrator;
  deployTargets: VerifiedDeployTargets;
  portReservations: PortReservationRepository;
  portInventory?: PortInventory;
  firewallInventory?: FirewallInventoryExporter;
  eventBus: EventBus;
  metricsCollector: MetricsCollector;
  /** The manager's own chain endpoint, BEE_RPC_ENDPOINT, or null for none. */
  beeRpcEndpoint: string | null;
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
  // /health needs no session: manager:upgrade and the integration suite wait on it.
  app.use('/health', createHealthRouter(deps.database));
  app.use('/auth', createAuthRouter(deps.authService, requireSession));
  app.use(requireSession);

  app.use(
    '/config',
    createConfigRouter(
      deps.chequebookService.floorBzz,
      () => deps.stackVersionService.hostPassphrase(),
      deps.beeRpcEndpoint,
    ),
  );
  app.use('/metrics', metrics);
  app.use('/events', events.router);
  // Before /versions, whose /:id route would otherwise take "attempts" for an id.
  app.use(
    '/versions/attempts',
    createAttemptsRouter(deps.orchestrator, (req) => req.user?.username ?? 'unknown'),
  );
  app.use(
    '/profiles',
    createProfilesRouter(deps.profileService, deps.uploaderHealthService, deps.beeRpcEndpoint !== null),
  );
  app.use('/profiles', createSrtPassphraseRouter(deps.profileService));
  app.use('/profiles', createSrtIngestRouter(deps.srtIngestHealthService));
  app.use('/targets', createTargetsRouter(deps.deployTargets, deps.portReservations, deps.portInventory, deps.firewallInventory));
  app.use('/groups', createGroupsRouter(deps.profileService, deps.beeRpcEndpoint !== null));
  app.use('/versions', createVersionsRouter(deps.stackVersionService, deps.openStreams));
  app.use('/', createActionsRouter(deps.deployService, deps.openStreams));
  app.use('/', createStampRouter(deps.stampService));
  app.use('/', createChequebookRouter(deps.chequebookService, deps.chequebookOperations));
  app.use('/', createEngineRouter(deps.profileService, deps.containerControl, deps.beeRpcEndpoint));
  app.use('/', createEngineConfigRouter(deps.engineConfigService));
  app.use('/', createDeploymentSettingsRouter(deps.deploymentSettingsService));
  app.use('/', createManagerSettingsRouter(deps.managerAdminLinkService));
  app.use('/', createAdminLinkTestRouter(deps.adminLinkTester));

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
