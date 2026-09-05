import { Alert, Stack, Typography } from '@mui/material';

import { OME_SERVICE } from '@streaming-infra-manager/common';

import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import { engineOf } from './shape';

/**
 * Which passphrase is already baked into the URL on screen.
 *
 * The host-wide one is a fallback that may not exist: a host with no
 * SRT_PASSPHRASE publishes in the clear, and saying "encrypted" there would be
 * the one sentence on this page that is not true.
 */
function passphraseNote(
  profile: Profile,
  hostPassphrase: string | null,
): string {
  if (engineOf(profile) === OME_SERVICE) {
    return 'OvenMediaEngine ingest. Its SRT listener takes no passphrase.';
  }
  if (profile.srt_passphrase?.trim()) {
    return "Encrypted with this deployment's own passphrase, already in the URL.";
  }
  return hostPassphrase
    ? 'Encrypted with the host-wide passphrase, already in the URL. Set a passphrase of its own under Edit.'
    : 'This host has no shared passphrase, so the ingest is unencrypted. Set one for this deployment under Edit.';
}

export function PublishCard({
  profile,
  url,
  hostPassphrase,
  ready,
}: {
  profile: Profile;
  url: string;
  hostPassphrase: string | null;
  /** False while the checklist is unfinished, so ingest works but Swarm does not. */
  ready: boolean;
}) {
  return (
    <SectionCard title="Publish" sub="OBS, FFmpeg or any SRT sender">
      <Stack spacing={1.25}>
        {!ready && (
          <Alert severity="warning">
            Ingest is up, but nothing reaches Swarm until the checklist above is
            complete.
          </Alert>
        )}
        <CopyBox value={url} />
        <Typography variant="caption" color="text.secondary">
          {passphraseNote(profile, hostPassphrase)} Change{' '}
          <code>live/stream</code> to your own app and stream name if you use
          one.
        </Typography>
      </Stack>
    </SectionCard>
  );
}
