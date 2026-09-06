/**
 * The character set a value may use when it is written to `.env.<profile>` and
 * then spliced into an engine config by the stack's entrypoint scripts.
 *
 * Both `engines/srs/entrypoint.sh` and `engines/ome/entrypoint.sh` substitute
 * these values with `sed "s/PLACEHOLDER/$VALUE/"`, where `/` ends the expression
 * and `&` expands to the whole match. Before that the value is a bare
 * `KEY=value` line, where `#` opens a comment and surrounding quotes are
 * stripped back off. The RFC 3986 unreserved set is what passes both untouched,
 * so that is what we accept, rather than escaping per hop and getting one of
 * them wrong.
 *
 * The SRT passphrase carries the same rule with length bounds of its own, and
 * takes its character class from here so the two cannot drift apart.
 */

// `-` is last so it stays a literal inside the character class.
export const ENV_SAFE_CHARS = 'A-Za-z0-9._~-';

export const ENV_SAFE_VALUE_RE = new RegExp(`^[${ENV_SAFE_CHARS}]+$`);

export const ENV_SAFE_VALUE_MESSAGE =
  'may only contain letters, digits and . _ ~ -';

export function isEnvSafeValue(value: string): boolean {
  return ENV_SAFE_VALUE_RE.test(value);
}
