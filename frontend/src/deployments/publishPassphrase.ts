import type { Profile } from '../types';

/** Reads one deployment's SRT passphrase. `fetchSrtPassphrase` in ordinary use. */
export type PassphraseReader = (name: string) => Promise<string | null>;

/**
 * The passphrase this deployment's publish URL carries.
 *
 * The deployment's own where it holds one, otherwise the host-wide
 * SRT_PASSPHRASE, which is the precedence the deploy applies when it writes
 * `.env.<profile>`. Null means the ingest is unencrypted, because neither is
 * set.
 *
 * `read` is the reveal route, and it is called only for a deployment the row
 * says holds a passphrase, and only when this is called. Callers call it when
 * an operator opens or copies the URL, which is what keeps the value out of
 * every other page.
 */
export async function publishPassphrase(
  profile: Pick<Profile, 'name' | 'has_srt_passphrase'>,
  hostPassphrase: string | null,
  read: PassphraseReader,
): Promise<string | null> {
  if (!profile.has_srt_passphrase) return hostPassphrase;
  return (await read(profile.name)) ?? hostPassphrase;
}
