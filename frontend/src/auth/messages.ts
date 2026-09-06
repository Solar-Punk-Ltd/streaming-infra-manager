/**
 * Everything the sign-in screen says, in one place.
 *
 * Deliberately vague about which half of the pair was wrong: naming the
 * username would tell anyone which accounts exist.
 */
export const SIGN_IN_MESSAGES = {
  wrongPair: 'Wrong username or password.',
  sessionEnded: 'Your session ended. Sign in again.',
  noUsers: 'No users yet. Create the first one on the host.',
  unreachable:
    'The manager did not answer. Check that it is running, then try again.',
} as const;

/** Said by both password forms, so they say it the same way. */
export const PASSWORD_MISMATCH = 'The two passwords are not the same.';

/** The rule, stated before it is broken rather than after. */
export const PASSWORD_RULE =
  'At least 12 characters, and it must not contain the username.';

/** The command that creates the first user, shown when there are none. */
export const FIRST_USER_COMMAND =
  'docker compose exec -it api node dist/cli.js user:add <username>';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** How long to wait, as an operator would say it. */
export function waitText(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return 'in less than a minute';
  if (seconds < SECONDS_PER_HOUR) {
    return `in ${plural(Math.ceil(seconds / SECONDS_PER_MINUTE), 'minute')}`;
  }
  return `in ${plural(Math.ceil(seconds / SECONDS_PER_HOUR), 'hour')}`;
}

export function tooManyAttempts(retryAfterSeconds: number): string {
  return `Too many attempts. Try again ${waitText(retryAfterSeconds)}.`;
}
