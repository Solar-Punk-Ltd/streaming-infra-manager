import { Alert, Box, CircularProgress, Stack } from '@mui/material';

import {
  isLadderKind,
  managesOwnStamp,
  rungFromMemberName,
  rungOrder,
} from '@streaming-infra-manager/common';

import type { DeploymentGroup, Profile } from '../types';
import { LadderCard, type LadderRung } from './LadderCard';
import { UploaderCard } from './UploaderCard';

/**
 * Everything with a postage batch to manage.
 *
 * An ABR ladder's rungs are ordinary bee-uploader profiles, so they render with
 * the same uploader card as everything else — just nested inside their ladder,
 * which is where they mean something. They are therefore removed from the
 * standalone list below, or they would appear twice.
 */
export function UploadersView({
  profiles,
  groups,
  onChanged,
  srtPassphrase,
}: {
  profiles: Profile[] | null;
  groups: DeploymentGroup[];
  onChanged: () => void;
  srtPassphrase: string | null;
}) {
  if (!profiles) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Keyed off the group's recorded kind, not the shape of its members: a ladder
  // with a rung removed is still a ladder, and hiding it here would remove the
  // one view that says which rung is missing.
  const ladders = groups.filter((g) => isLadderKind(g.kind));

  const rungsOf = (group: DeploymentGroup): LadderRung[] =>
    profiles
      .filter((p) => p.group_id === group.id)
      .map((profile) => ({
        rung: rungFromMemberName(group.name, profile.name),
        profile,
      }))
      .filter((r): r is LadderRung => r.rung !== null)
      .sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung));

  const claimed = new Set(
    ladders.flatMap((g) => rungsOf(g).map((r) => r.profile.name)),
  );

  // A bee-only profile that belongs to no ladder still needs funding, so the
  // filter excludes claimed rungs specifically rather than bee-only profiles.
  const standalone = profiles.filter(
    (p) => managesOwnStamp(p) && !claimed.has(p.name),
  );

  if (ladders.length === 0 && standalone.length === 0) {
    return (
      <Alert severity="info">
        No uploader instances yet. Deploy a streamer (or a custom profile with
        the <code>stream-uploader</code> component) to manage postage stamps
        here, or an ABR Uploader Pool to stand up one Bee node per quality rung.
      </Alert>
    );
  }

  return (
    <Stack spacing={1}>
      {ladders.map((group) => (
        <LadderCard
          key={group.id}
          group={group}
          rungs={rungsOf(group)}
          onChanged={onChanged}
          srtPassphrase={srtPassphrase}
        />
      ))}
      {standalone.map((p) => (
        <UploaderCard
          key={p.name}
          profile={p}
          onChanged={onChanged}
          srtPassphrase={srtPassphrase}
        />
      ))}
    </Stack>
  );
}
