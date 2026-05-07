import { ApiServerHandle, startApiServer } from './api/server.js';
import { Database } from './domain/Database.js';
import { DeployService } from './domain/DeployService.js';
import { Logger } from './domain/Logger.js';
import { ProfileRepository } from './domain/ProfileRepository.js';
import { ProfileService } from './domain/ProfileService.js';
import { ScriptRunner } from './domain/ScriptRunner.js';
import { config } from './utils/config.js';

const logger = Logger.getInstance();

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
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
    process.exit(1);
  }
}

async function main(): Promise<void> {
  database = new Database(config.databaseUrl);
  await database.migrate();

  const profileRepository = new ProfileRepository(database.pool);
  const profileService = new ProfileService(profileRepository);

  const scriptRunner = new ScriptRunner();
  const deployService = new DeployService(profileService, scriptRunner);

  apiServer = startApiServer(
    { database, profileService, deployService },
    config.port,
    config.host,
  );
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  if (reason instanceof Error && reason.stack) logger.error(reason.stack);
});

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  if (err instanceof Error && err.stack) logger.error(err.stack);
  process.exit(1);
});
