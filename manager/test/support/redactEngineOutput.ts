import { isSecretSettingKey } from '@streaming-infra-manager/common';

/**
 * A name in the engine's own output that would end one of the settings keys
 * common calls secret. The engine writes `passphrase <value>;` and
 * `...?token=<value>`, where the manager knows the same two values as
 * SRT_PASSPHRASE and SRS_WEBHOOK_TOKEN, so the rule is asked about the word as
 * the tail of a key rather than kept as a second list here.
 */
function namesASecret(word: string): boolean {
  const key = word.toUpperCase();
  return isSecretSettingKey(key) || isSecretSettingKey(`_${key}`);
}

/** `token=value`, in a URL query or an env line. Taken first, since a URL is one word. */
const ASSIGNED_VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)=([^\s;&"']+)/g;

/** `passphrase value;`, the way a config directive carries one. */
const DIRECTIVE_VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)([ \t]+)([^\s;"']+)/g;

export const REDACTED = '<redacted>';

/**
 * The engine's last lines with every secret-shaped value taken out.
 *
 * A rollout that reverts carries the engine's own output as its reason, which
 * is the point: an operator has to see why. The same text ends up in an
 * assertion message, and an assertion message on a runner is a public log,
 * while the file SRS was started on carries the deployment's SRT passphrase
 * and its webhook token. Safe for the failure this test is about, not as a
 * habit.
 */
export function redactEngineOutput(text: string): string {
  return text
    .replace(ASSIGNED_VALUE_RE, (whole, word: string) =>
      namesASecret(word) ? `${word}=${REDACTED}` : whole,
    )
    .replace(DIRECTIVE_VALUE_RE, (whole, word: string, spacing: string) =>
      namesASecret(word) ? `${word}${spacing}${REDACTED}` : whole,
    );
}
