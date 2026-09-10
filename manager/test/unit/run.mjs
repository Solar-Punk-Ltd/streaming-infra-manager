/**
 * Runs the manager unit suite on a stack checkout of its own.
 *
 * A deployment writes its env file into the root of the checkout it deploys,
 * and src/utils/envUtils.js reads that root out of SHLS_ROOT once, when it is
 * first imported. A unit file that sets the variable after an import which
 * reaches envUtils therefore deploys into manager/swarm-hls-stream, the real
 * submodule, and leaves a .env.<profile> there merged from the developer's own
 * .env. This run makes that impossible rather than asking every file to
 * remember: one throwaway root for the whole suite, removed when it ends.
 *
 * Usage, from the manager package:
 *
 *   pnpm test
 *
 * To run a single file, give it a root of its own the same way:
 *
 *   SHLS_ROOT="$(mktemp -d)" tsx --conditions=development --test test/unit/<file>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Where a checkout's root is named, read by envUtils at import time. */
export const STACK_ROOT_VARIABLE = 'SHLS_ROOT';

/**
 * A database URL that names nothing, for a run that opens no database.
 *
 * src/utils/config.ts requires the variable when it is first imported, and 26
 * unit files reach it, so a checkout with no manager/.env fails them all at
 * import. dotenv never overwrites a variable that is already set, so a
 * developer's own URL still wins when they exported one.
 */
export const PLACEHOLDER_DATABASE_URL = 'postgres://unused@localhost/unused';

export const UNIT_ARGS = ['--conditions=development', '--test', 'test/unit/**/*.test.ts'];

const ROOT_PREFIX = 'manager-unit-stack-';
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The environment the suite runs in.
 *
 * A root the caller already exported is replaced rather than kept, because the
 * point is that no unit test writes into a checkout anyone else can see. A
 * database URL, by contrast, is only filled in when the caller has none, so a
 * run against a real one is still possible.
 */
export function sandboxedEnv(env, root) {
  return {
    ...env,
    DATABASE_URL: env.DATABASE_URL ?? PLACEHOLDER_DATABASE_URL,
    [STACK_ROOT_VARIABLE]: root,
  };
}

/** Why the run was not green, in words, or null. */
export function runProblem({ code, signal }) {
  if (signal) return `The unit suite was killed by ${signal}.`;
  if (code !== 0) return `The unit suite exited with code ${code}.`;
  return null;
}

function runSuites(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, UNIT_ARGS, { cwd: PACKAGE, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  try {
    const problem = runProblem(await runSuites(sandboxedEnv(process.env, root)));
    if (problem) {
      console.error(`REFUSED: ${problem}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(`REFUSED: the unit runner itself failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
