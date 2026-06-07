import { getErrorStack } from '@streaming-infra-manager/common';

import { ApiServerHandle, startApiServer } from './api/server.js';
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
import { config } from './utils/config.js';
import { bootstrapSubmoduleDefaults } from './utils/envUtils.js';
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
  logger.info(`[Boot]   database: ${redactDatabaseUrl(config.databaseUrl)}`);
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let metricsCollector: MetricsCollector | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
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

  const bootstrapped = await bootstrapSubmoduleDefaults();
  for (const file of bootstrapped) {
    logger.info(`[Boot] created missing default: ${file}`);
  }

  database = new Database(config.databaseUrl);
  await database.migrate();

  const eventBus = new EventBus();
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

  const scriptRunner = new ScriptRunner();
  const orchestrator = new DeploymentOrchestrator(
    profileRepository,
    containerRepository,
    scriptRunner,
    eventBus,
  );
  const deploymentGroupRepository = new DeploymentGroupRepository(
    database.pool,
  );
  const profileService = new ProfileService(
    profileRepository,
    containerRepository,
    orchestrator,
    eventBus,
    deploymentGroupRepository,
  );
  const deployService = new DeployService(profileService, orchestrator);
  const stampService = new StampService(
    profileRepository,
    containerRepository,
    eventBus,
  );

  metricsCollector = new MetricsCollector();
  // Scope "our infra" metrics to containers this tool deployed (compose project
  // = profile name), so unrelated stacks on the host (e.g. a bee cluster) are
  // counted as "outside our infra", not part of our totals.
  metricsCollector.setKnownProjectsProvider(
    async () => new Set((await profileRepository.list()).map((p) => p.name)),
  );

  apiServer = startApiServer(
    {
      database,
      profileService,
      deployService,
      stampService,
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
