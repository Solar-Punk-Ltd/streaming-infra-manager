/**
 * SRT passphrase rules, shared by the manager's request schemas and the UI's
 * inline validation so both refuse exactly the same values.
 *
 * The length bounds are libsrt's: `SRTO_PASSPHRASE` is rejected outside 10-79
 * characters, so anything shorter would be accepted here and then refused by SRS
 * at startup — under `restart: unless-stopped`, as a crash loop.
 *
 * The character set is narrower than libsrt's, deliberately. One passphrase is
 * substituted into four places that each read punctuation differently:
 *
 *   - `engines/srs/entrypoint.sh` splices it in with
 *     `sed "s/PASSPHRASE_PLACEHOLDER/$SRT_PASSPHRASE/"`, where `/` ends the
 *     expression and `&` expands to the whole match;
 *   - it is written to `.env.<profile>` as a bare `KEY=value`, where `#` opens a
 *     comment and surrounding quotes are stripped back off;
 *   - it lands in srs.conf as a bare `passphrase <value>;` token, which `;`,
 *     `{`, `}` and whitespace terminate early;
 *   - the UI appends it to an `srt://…?…&passphrase=` query, where `&`, `=`, `#`
 *     and `%` change what the publisher sends.
 *
 * The RFC 3986 unreserved set is what passes all four untouched, so that is what
 * we accept — rather than escaping per hop and getting one of them wrong.
 */
export const SRT_PASSPHRASE_MIN = 10;
export const SRT_PASSPHRASE_MAX = 79;

// `-` is last so it stays a literal inside the character class.
const SRT_PASSPHRASE_CHARS = 'A-Za-z0-9._~-';

export const SRT_PASSPHRASE_RE = new RegExp(
  `^[${SRT_PASSPHRASE_CHARS}]{${SRT_PASSPHRASE_MIN},${SRT_PASSPHRASE_MAX}}$`,
);

export const SRT_PASSPHRASE_MESSAGE =
  `must be ${SRT_PASSPHRASE_MIN}-${SRT_PASSPHRASE_MAX} characters, ` +
  'using only letters, digits and . _ ~ -';

export function isValidSrtPassphrase(value: string): boolean {
  return SRT_PASSPHRASE_RE.test(value);
}

/**
 * Alphabet for a generated passphrase: exactly 64 characters, every one of them
 * inside the set `SRT_PASSPHRASE_RE` accepts.
 *
 * 64 divides 256, so indexing it with a random byte is uniform. A 62-character
 * alphabet — the obvious alphanumeric one — would make its first two letters
 * marginally likelier than the rest.
 */
const PASSPHRASE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A random passphrase this module's own rules accept.
 *
 * Offered beside every passphrase field because the accepted character set is
 * narrower than a password manager's default — see the note above — and a
 * rejected paste is a worse first encounter with that than a button. It lives
 * here, next to the rule it has to satisfy, so the two cannot drift apart.
 */
export function generateSrtPassphrase(length = 32): string {
  if (length < SRT_PASSPHRASE_MIN || length > SRT_PASSPHRASE_MAX) {
    throw new Error(
      `generateSrtPassphrase: length ${SRT_PASSPHRASE_MESSAGE}`,
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(
    bytes,
    (b) => PASSPHRASE_ALPHABET[b % PASSPHRASE_ALPHABET.length],
  ).join('');
}
