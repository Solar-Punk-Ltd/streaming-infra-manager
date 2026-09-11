import { fileURLToPath } from 'node:url';

/**
 * Where one suite's Vite keeps the dependencies it pre-bundled.
 *
 * Vite re-optimizes a cache that a different config built, and every suite
 * here starts a Vite with a plugin set of its own, so one shared directory
 * means each suite pays for the config of the suite before it. On the runner
 * that showed up as `Re-optimizing dependencies because vite config has
 * changed` at the start of five suites in a row.
 *
 * This is a fixed directory per suite inside `node_modules`, which the
 * repository does not carry and which a fresh install removes with everything
 * else there.
 *
 * @param {string} suite the suite's own name, such as `pool-draft`.
 * @returns {string} the absolute directory that suite's Vite may build in.
 */
export function viteCacheFor(suite) {
  return fileURLToPath(new URL(`../../node_modules/.vite-t09/${suite}`, import.meta.url));
}
