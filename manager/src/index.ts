import { getErrorStack, plurToBzz } from '@streaming-infra-manager/common';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/auth/AuthService.js';
import { OpenStreams } from './domain/auth/OpenStreams.js';
import { PostgresCredentialRepository } from './domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from './domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from './domain/auth/PostgresUserRepository.js';
import { SessionSweep, startSessionSweep } from './domain/auth/sessionSweep.js';
import {
  StreamRevalidation,
  startStreamRevalidation,
} from './domain/auth/streamRevalidation.js';
import { ChequebookService } from './domain/ChequebookService.js';
import { ContainerControl } from './domain/ContainerControl.js';
import { ContainerRepository } from './domain/ContainerRepository.js';
import { Database } from './domain/Database.js';
import { DeployService } from './domain/DeployService.js';
import { DeploymentGroupRepository } from './domain/DeploymentGroupRepository.js';
import { DeploymentOrchestrator } from './domain/DeploymentOrchestrator.js';
import { EventBus } from './domain/EventBus.js';
import { Logger } from './domain/Logger.js';
import { MetricsCollector } from './domain/MetricsCollector.js';
import { ProfileRepository } from './domain/ProfileRepository.js';
import { ProfileService } from './domain/ProfileService.js';
import { ScriptRunner } from './domain/ScriptRunner.js';
import { StampService } from './domain/StampService.js';
import { UploaderStartGate } from './domain/UploaderStartGate.js';
import { readBundledCommit } from './domain/versions/bundledCommit.js';
import { EngineConfigChecker } from './domain/engineConfig/engineConfigCheck.js';
import { EngineConfigService } from './domain/engineConfig/EngineConfigService.js';
import { PostgresStackVersionRepository } from './domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from './domain/versions/StackVersionService.js';
import { config } from './utils/config.js';
import { BUNDLED_STACK_ROOT, bootstrapStackDefaults } from './utils/envUtils.js';
import { resolveServerHost } from './utils/serverHost.js';

const logger = Logger.getInstance();

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable>';
  }
}

function logStartupConfig(): void {
  logger.info('[Boot] configuration:');
  logger.info(`[Boot]   listen: ${config.host}:${config.port}`);
  logger.info(
    `[Boot]   publicHost: ${config.publicHost || '(unset → localhost)'}`,
  );
  logger.info(`[Boot]   serverHost (resolved): ${resolveServerHost()}`);
  logger.info(`[Boot]   logLevel: ${config.logLevel}`);
  logger.info(
    `[Boot]   chequebookFloor: ${plurToBzz(config.chequebookFloorPlur)} BZZ`,
  );
  logger.info(`[Boot]   database: ${redactDatabaseUrl(config.databaseUrl)}`);
  logger.info(`[Boot]   bundled stack: ${BUNDLED_STACK_ROOT}`);
  logger.info(`[Boot]   stack versions root: ${config.stackVersionsRoot}`);
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let metricsCollector: MetricsCollector | undefined;
let sessionSweep: SessionSweep | undefined;
let streamRevalidation: StreamRevalidation | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    if (sessionSweep) {
      sessionSweep.stop();
      sessionSweep = undefined;
    }
    if (streamRevalidation) {
      streamRevalidation.stop();
      streamRevalidation = undefined;
    }
    if (metricsCollector) {
      metricsCollector.stop();
      metricsCollector = undefined;
    }
    if (apiServer) {
      await apiServer.close();
      apiServer = undefined;
    }
    if (database) {
      await database.close();
      database = undefined;
    }
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    const stack = getErrorStack(error);
    if (stack) {
      logger.error(stack);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  logStartupConfig();

  const bootstrapped = await bootstrapStackDefaults(BUNDLED_STACK_ROOT);
  for (const file of bootstrapped) {
    logger.info(`[Boot] created missing default: ${file}`);
  }

  database = new Database(config.databaseUrl);
  await database.migrate();

  const eventBus = new EventBus();
  const openStreams = new OpenStreams();
  const authService = new AuthService(
    new PostgresUserRepository(database.pool),
    new PostgresSessionRepository(database.pool),
    new PostgresCredentialRepository(database.pool),
    openStreams,
  );
  sessionSweep = startSessionSweep(authService);
  streamRevalidation = startStreamRevalidation(authService);

  if ((await authService.countUsers()) === 0) {
    logger.warn(
      '[Boot] no users exist yet. Every route but /health refuses until one is created with: node dist/cli.js user:add <username>',
    );
  }

  const scriptRunner = new ScriptRunner();
  const stackVersionRepository = new PostgresStackVersionRepository(
    database.pool,
  );
  const stackVersionService = new StackVersionService(
    stackVersionRepository,
    scriptRunner,
    eventBus,
    config.stackVersionsRoot,
  );
  await stackVersionService.refreshBundled(
    BUNDLED_STACK_ROOT,
    readBundledCommit(BUNDLED_STACK_ROOT),
  );

  const interruptedBuilds = await stackVersionService.failInterruptedBuilds();
  if (interruptedBuilds.length > 0) {
    logger.warn(
      `[Boot] stack version builds interrupted by a restart: ${interruptedBuilds.join(', ')}`,
    );
  }

  const profileRepository = new ProfileRepository(database.pool);
  const containerRepository = new ContainerRepository(database.pool);

  const orphans = await profileRepository.resetOrphanedTransitions();
  if (orphans.length > 0) {
    logger.warn(
      `[Boot] reset orphaned transitional states: ${orphans
        .map((p) => p.name)
        .join(', ')}`,
    );
    for (const profile of orphans) {
      const withContainers = await containerRepository.withContainers(profile);
      eventBus.publish({
        type: 'profile.changed',
        profile: withContainers,
      });
    }
  }

  const deploymentGroupRepository = new DeploymentGroupRepository(
    database.pool,
  );
  // Ahead of the orchestrator and ProfileService: the uploader gate asks it
  // whether a batch is still usable, and a ladder's readiness depends on what
  // each rung's bee node says about its own.
  const stampService = new StampService(
    profileRepository,
    containerRepository,
    eventBus,
  );
  // A drained chequebook is the stamp failure one layer down: peers stop
  // forwarding what the node cannot pay them for. The gate asks about both.
  const chequebookService = new ChequebookService(
    profileRepository,
    config.chequebookFloorPlur,
    eventBus,
  );
  const orchestrator = new DeploymentOrchestrator(
    profileRepository,
    containerRepository,
    scriptRunner,
    eventBus,
    deploymentGroupRepository,
    stackVersionRepository,
    new UploaderStartGate(stampService, chequebookService),
  );
  const profileService = new ProfileService(
    profileRepository,
    containerRepository,
    orchestrator,
    eventBus,
    deploymentGroupRepository,
    stackVersionRepository,
    (profile, stampId) => stampService.stampHealthFor(profile, stampId),
    (url) => stampService.publishUrlStateFor(url),
  );
  const deployService = new DeployService(profileService, orchestrator);

  const containerControl = new ContainerControl(eventBus);
  const engineConfigService = new EngineConfigService(
    profileRepository,
    containerRepository,
    orchestrator,
    stackVersionRepository,
    containerControl,
    new EngineConfigChecker(),
    eventBus,
  );

  metricsCollector = new MetricsCollector();
  metricsCollector.setManagedProjectsProvider(
    async () => new Set((await profileRepository.list()).map((p) => p.name)),
  );

  apiServer = startApiServer(
    {
      database,
      authService,
      openStreams,
      profileService,
      deployService,
      stampService,
      chequebookService,
      containerControl,
      engineConfigService,
      stackVersionService,
      eventBus,
      metricsCollector,
    },
    config.port,
    config.host,
  );
}

function stop() {
  setTimeout(() => process.exit(1), 1000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);

  stop();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  const stack = getErrorStack(reason);
  if (stack) {
    logger.error(stack);
  }

  stop();
});

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  const stack = getErrorStack(err);
  if (stack) {
    logger.error(stack);
  }

  stop();
});
