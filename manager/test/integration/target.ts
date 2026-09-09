/**
 * What the suite refuses to start without, decided before any request goes
 * out.
 *
 * The suite creates and removes deployments on whatever manager it is pointed
 * at. So the target is named twice, once as the URL and once as the statement
 * that this URL is a test target, and the two have to agree: a MANAGER_URL
 * left in a shell is then not enough to aim the suite at a host that carries
 * funded deployments. The sign-in comes from the environment, put there by
 * `op run --env-file`, and nothing here ever prints a value.
 */

export const DEFAULT_MANAGER_URL = 'http://localhost:9876';

export const MANAGER_URL_VAR = 'MANAGER_URL';
export const TEST_TARGET_VAR = 'MANAGER_TEST_TARGET';
export const USERNAME_VAR = 'MANAGER_TEST_USERNAME';
export const PASSWORD_VAR = 'MANAGER_TEST_PASSWORD';
export const RUN_ID_VAR = 'MANAGER_TEST_RUN';

/** Every resource the suite creates is named `itest-<run>-...`. */
export const PREFIX = 'itest';

/** The environment as the suite reads it, so a test can hand in one of its own. */
export type TargetEnv = Partial<Record<string, string>>;

export function baseUrlOf(env: TargetEnv): string {
  return env[MANAGER_URL_VAR] ?? DEFAULT_MANAGER_URL;
}

/** Why the suite must not start, naming variables and never their values, or null. */
export function targetProblem(env: TargetEnv): string | null {
  const base = baseUrlOf(env);
  const declared = env[TEST_TARGET_VAR];
  if (!declared) {
    return `${TEST_TARGET_VAR} is not set. The suite creates and removes deployments, so set it to ${base} to say that manager is a test target.`;
  }
  if (canonical(declared) !== canonical(base)) {
    return `${TEST_TARGET_VAR} names a different manager than ${MANAGER_URL_VAR}. The suite runs only against the manager it was told is a test target.`;
  }
  if (!env[USERNAME_VAR] || !env[PASSWORD_VAR]) {
    return `${USERNAME_VAR} and ${PASSWORD_VAR} must both be set. Route them from the vault with op run --env-file, see test/integration/README.md.`;
  }
  return null;
}

function canonical(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** Lowercase letters and digits only, because the id goes into deployment names. */
const RUN_ID_RE = /^[a-z0-9]{1,8}$/;
const RUN_ID_LENGTH = 5;
const NAME_TIE_BREAKER_LENGTH = 4;

/**
 * The id every name of this run carries.
 *
 * From the environment when the caller set one, so the suite files, which
 * the runner starts as separate processes, share it. Otherwise each file is
 * a run of its own.
 */
export function runIdFrom(env: TargetEnv): string {
  const given = env[RUN_ID_VAR];
  if (given === undefined) return randomToken(RUN_ID_LENGTH);
  if (!RUN_ID_RE.test(given)) {
    throw new Error(
      `${RUN_ID_VAR} must be 1 to 8 lowercase letters or digits, it goes into deployment names`,
    );
  }
  return given;
}

function randomToken(length: number): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .padEnd(length, '0');
}

/** `itest-<run>-<base>-<random>`: what the test calls it, and a tie-breaker within the run. */
export function runName(runId: string, base: string): string {
  return `${PREFIX}-${runId}-${base}-${randomToken(NAME_TIE_BREAKER_LENGTH)}`;
}

/** Whether a name is one this run made, which is the only kind cleanup may remove. */
export function belongsToRun(runId: string, name: string): boolean {
  return name.startsWith(`${PREFIX}-${runId}-`);
}
