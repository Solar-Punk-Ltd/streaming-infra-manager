import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import { isLadderKind } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { useDeployments } from '../app/useDeploymentsStore';
import { EmptyState } from '../components/EmptyState';
import { usePoolResults } from '../groups/useBeePublishers';
import type { Profile } from '../types';
import { DeploymentRow } from './DeploymentRow';
import { GroupBlockRows } from './GroupBlockRows';
import { needsAttention } from './readiness';
import { SHAPE_LABEL, shapeOf } from './shape';

type FilterKey = 'all' | 'streams' | 'viewers' | 'abr' | 'groups' | 'attention';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'streams', label: 'Streams' },
  { key: 'viewers', label: 'Viewers' },
  { key: 'abr', label: 'ABR' },
  { key: 'groups', label: 'Groups' },
  { key: 'attention', label: 'Needs attention' },
];

const MATCHERS: Record<
  Exclude<FilterKey, 'all' | 'groups'>,
  (profile: Profile) => boolean
> = {
  streams: (profile) => ['stream', 'abr-uploader'].includes(shapeOf(profile)),
  viewers: (profile) => shapeOf(profile) === 'viewer',
  abr: (profile) => ['bee-node', 'abr-uploader'].includes(shapeOf(profile)),
  attention: (profile) => needsAttention(profile),
};

export function DeploymentsPage({ search }: { search: string }) {
  const { profiles, groups } = useDeployments();
  const { openWizard } = useEditors();
  const [filter, setFilter] = useState<FilterKey>('all');
  const poolResults = usePoolResults(groups, profiles);

  if (!profiles) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const query = search.trim().toLowerCase();
  const matches = (profile: Profile): boolean => {
    const hitsQuery =
      !query ||
      profile.name.toLowerCase().includes(query) ||
      (profile.notes ?? '').toLowerCase().includes(query);
    if (!hitsQuery) return false;
    if (filter === 'all' || filter === 'groups') return true;
    return MATCHERS[filter](profile);
  };

  const counts: Record<FilterKey, number> = {
    all: profiles.length,
    streams: profiles.filter(MATCHERS.streams).length,
    viewers: profiles.filter(MATCHERS.viewers).length,
    abr: profiles.filter(MATCHERS.abr).length,
    groups: groups.length,
    attention: profiles.filter(MATCHERS.attention).length,
  };

  const membersOf = (groupId: number) =>
    profiles.filter((profile) => profile.group_id === groupId);

  const groupBlocks = groups
    .map((group) => {
      const members = membersOf(group.id);
      const visible = filter === 'groups' ? members : members.filter(matches);
      return { group, members, visible };
    })
    .filter(({ visible }) => filter === 'groups' || visible.length > 0);

  // A member whose group has not loaded, or whose group fetch failed, is listed
  // on its own rather than dropped: the counts above still include it, and the
  // two fetches race on every cold load.
  const loadedGroupIds = new Set(groups.map((group) => group.id));
  const standalone =
    filter === 'groups'
      ? []
      : profiles.filter(
          (profile) =>
            (profile.group_id == null || !loadedGroupIds.has(profile.group_id)) &&
            matches(profile),
        );

  const hasRows = groupBlocks.length > 0 || standalone.length > 0;

  if (profiles.length === 0) {
    return (
      <Paper>
        <EmptyState
          title="No deployments yet."
          hint="A deployment is one stack the manager runs for you: a stream, a viewer, a Bee node or a pool of them."
          action={
            <Button variant="contained" onClick={() => openWizard()}>
              New deployment
            </Button>
          }
        />
      </Paper>
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={0.75} sx={{ mb: 1.75, flexWrap: 'wrap', rowGap: 1 }}>
        {FILTERS.map(({ key, label }) => (
          <Chip
            key={key}
            label={`${label} ${counts[key]}`}
            onClick={() => setFilter(key)}
            color={filter === key ? 'primary' : 'default'}
            variant={filter === key ? 'filled' : 'outlined'}
          />
        ))}
      </Stack>

      <Paper sx={{ overflow: 'hidden' }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell />
              <TableCell>Name</TableCell>
              <TableCell>State</TableCell>
              <TableCell>Links</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {hasRows ? (
              <>
                {groupBlocks.map(({ group, members, visible }) => (
                  <GroupBlockRows
                    key={group.id}
                    group={group}
                    members={members}
                    visibleMembers={visible}
                    poolResult={
                      isLadderKind(group.kind)
                        ? (poolResults.get(group.id) ?? null)
                        : null
                    }
                    memberNoun={memberNoun(members)}
                  />
                ))}
                {standalone.map((profile) => (
                  <DeploymentRow key={profile.name} profile={profile} />
                ))}
              </>
            ) : (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    title="Nothing matches."
                    hint="Clear the search box or pick another filter above."
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1.25, display: 'block' }}>
        Click a row to open it. Every action is on the row itself, nothing needs
        to be selected first.
      </Typography>
    </Box>
  );
}

function memberNoun(members: Profile[]): string {
  const first = members[0];
  if (!first) return 'members';
  return `${SHAPE_LABEL[shapeOf(first)].toLowerCase()}s`;
}
