import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A directory for one test file, gone when that file's process ends.
 *
 * A unit file that needs a checkout on disk has to make it before its first
 * import, because `src/utils/envUtils.js` reads `SHLS_ROOT` once when it
 * loads. That puts the directory at module scope, where `afterEach` cannot
 * reach it, and thirty six files made one and left it. Measured 2026-09-11:
 * 257 abandoned directories in the machine's temp folder, 49 MB, one per
 * `pnpm test` run over three days.
 *
 * `exit` is the one hook that still runs after the test runner has finished
 * its own work, and it only admits synchronous work, which is why the removal
 * is the synchronous one. A process killed outright runs no hook at all and
 * leaves its directory, which is the same as today and is what the temp folder
 * is for.
 */
export function throwawayRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
