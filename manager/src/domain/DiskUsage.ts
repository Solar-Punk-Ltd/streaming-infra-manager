import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();
const execFileAsync = promisify(execFile);

const DU_TIMEOUT_MS = 15_000;

const BEE_DATA_ROOT =
  process.env.BEE_DATA_ROOT ?? '/home/solarpunk/streaming-infra-manager-data';

/** Reject names that could escape BEE_DATA_ROOT via traversal. */
function isSafeProject(name: string): boolean {
  return Boolean(name) && !/[/\\]/.test(name) && !name.includes('..');
}

/**
 * On-disk footprint of a profile's data directory
 * (BEE_DATA_ROOT/<project>), in bytes. Returns null when the directory does
 * not exist (e.g. the manager's own stack) or the lookup fails — disk size is
 * a best-effort detail, never a hard error.
 */
export async function getProfileDiskUsage(
  project: string,
): Promise<number | null> {
  if (!isSafeProject(project)) {
    logger.warn(`[DiskUsage] refusing suspicious project name "${project}"`);
    return null;
  }

  const dir = join(BEE_DATA_ROOT, project);
  if (!existsSync(dir)) return null;

  try {
    // `du -sb` reports apparent size in bytes (GNU coreutils, present in the
    // linux api container). Run via execFile (no shell) so the path can't be
    // interpreted as shell metacharacters.
    const { stdout } = await execFileAsync('du', ['-sb', dir], {
      timeout: DU_TIMEOUT_MS,
    });
    const bytes = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(bytes) ? bytes : null;
  } catch (err) {
    logger.debug(
      `[DiskUsage] du failed for ${project}: ${getErrorMessage(err)}`,
    );
    return null;
  }
}
