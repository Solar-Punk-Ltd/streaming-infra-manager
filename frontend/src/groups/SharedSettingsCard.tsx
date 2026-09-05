import { Box, Button, Typography } from '@mui/material';

import { CLIENT_SERVICE, SRS_SERVICE } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { MONO_STACK } from '../app/theme';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { SectionCard } from '../components/SectionCard';
import { hasService, SHAPE_LABEL, shapeOf } from '../deployments/shape';
import { shortHex } from '../format';
import type { DeploymentGroup, Profile } from '../types';
import { hostFor } from '../urls';

/** What every member of a standard group has in common. */
export function SharedSettingsCard({
  group,
  members,
  serverHost,
  streamerName,
}: {
  group: DeploymentGroup;
  members: Profile[];
  serverHost: string;
  streamerName: string | null;
}) {
  const { openEditGroup } = useEditors();
  const first = members[0];
  if (!first) return null;

  const entries: KeyValueEntry[] = [
    { key: 'Type', value: SHAPE_LABEL[shapeOf(first)] },
    {
      key: 'Host',
      value: (
        <Box component="span" sx={{ fontFamily: MONO_STACK }}>
          {hostFor(first, serverHost)}
        </Box>
      ),
    },
  ];

  if (hasService(first, CLIENT_SERVICE)) {
    entries.push({
      key: 'Follows streamer',
      value: first.feed_owner ? (
        <Box component="span" sx={{ fontFamily: MONO_STACK }}>
          {shortHex(first.feed_owner)}
          {streamerName ? ` (${streamerName})` : ''}
        </Box>
      ) : (
        'none'
      ),
    });
  }

  if (hasService(first, SRS_SERVICE)) {
    entries.push({
      key: 'SRT passphrase',
      value: first.srt_passphrase?.trim()
        ? 'own passphrase'
        : 'host-wide passphrase (default)',
    });
  }

  entries.push({ key: 'Notes', value: first.notes || 'none' });

  return (
    <SectionCard
      title="Shared settings"
      sub="applied to every member"
      actions={
        <Button size="small" onClick={() => openEditGroup(group.id)}>
          Edit
        </Button>
      }
    >
      <KeyValueList entries={entries} />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1.25, display: 'block' }}>
        New members inherit these. Keys and stamps are never bulk-applied.
      </Typography>
    </SectionCard>
  );
}
