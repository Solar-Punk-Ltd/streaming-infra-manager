import { randomBytes } from 'node:crypto';

/**
 * The per deployment values a stack version's containers refuse to start
 * without, by env key. `API_AUTH_TOKEN` and `SRS_WEBHOOK_TOKEN` on main-v3.
 */
export type StackSecrets = Record<string, string>;

const SECRET_BYTES = 32;

/** An env key as the stack's samples spell them, and nothing that could escape a line. */
export const STACK_SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** What `missingStackSecrets` produces: 64 hex characters, so a value is checked against this before it is written anywhere. */
export const STACK_SECRET_VALUE_RE = /^[0-9a-f]{64}$/;

/**
 * A fresh value for every required secret the deployment does not hold yet.
 *
 * 64 hex characters, which clears the 32 the stack's samples ask for with room
 * to spare. A stored value is never replaced: the running containers were
 * started with it, and rotating a token is a decision, not a side effect of a
 * deploy.
 */
export function missingStackSecrets(
  required: readonly string[],
  stored: StackSecrets,
): StackSecrets {
  const generated: StackSecrets = {};
  for (const key of required) {
    if (!STACK_SECRET_KEY_RE.test(key)) {
      throw new Error(
        `refusing to generate a secret for ${JSON.stringify(key)}: not an env key`,
      );
    }
    if (stored[key]) continue;
    generated[key] = randomBytes(SECRET_BYTES).toString('hex');
  }
  return generated;
}
