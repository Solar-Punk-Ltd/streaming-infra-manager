import {
  Box,
  Button,
  CircularProgress,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import { isLadderKind } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { useDeployments } from '../app/useDeploymentsStore';
import { EmptyState } from '../components/EmptyState';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import { ShapePill } from '../components/ShapePill';
import { streamerFor } from '../deployments/checklist';
import { isRunning, isTransitional, SHAPE_LABEL, shapeOf, streamersOf } from '../deployments/shape';
import { formatDate } from '../format';
import type { Profile } from '../types';
import { GroupMembersCard } from './GroupMembersCard';
import { groupReadinessOf } from './groupReadiness';
import { PoolStringCard } from './PoolStringCard';
import { SharedSettingsCard } from './SharedSettingsCard';
import { useBeePublishers } from './useBeePublishers';

const POOL_EXPLAINER =
  'Each rung is an ordinary Bee node with its own wallet and stamp. Higher rungs burn storage faster, so their suggested stamp depth is larger (17, 18, 19, 20). The 360p node is the coordinator, it carries the stream catalog and the master playlist. Once all four are stamped, copy the pool string into an ABR uploader.';

export function GroupPage({ id }: { id: number }) {
  const { profiles, groups, serverHost } = useDeployments();
  const actions = useActions();
  const { openEditGroup } = useEditors();

  const group = groups.find((entry) => entry.id === id) ?? null;
  const members = (profiles ?? []).filter((profile) => profile.group_id === id);
  const isPool = group ? isLadderKind(group.kind) : false;

  const stampFingerprint = members
    .map((member) => `${member.name}:${member.stamp_id ?? ''}:${member.status}`)
    .join('|');
  const publishers = useBeePublishers(isPool ? id : null, stampFingerprint);

  if (!profiles) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!group) {
    return (
      <Paper>
        <EmptyState
          title="No group with that id."
          hint="It may have been removed once its last member was deleted."
          action={
            <Button variant="contained" onClick={() => navigate(routes.deployments)}>
              Back to deployments
            </Button>
          }
        />
      </Paper>
    );
  }

  const readiness = groupReadinessOf(group, members, publishers.result);
  const startable = members.some((m) => !isRunning(m) && !isTransitional(m));
  const streamerName =
    streamerFor(members[0]?.feed_owner, streamersOf(profiles))?.name ?? null;

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'flex-start' }}
        sx={{ pt: 1.5, pb: 2.25 }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="caption" component="div" sx={{ mb: 1 }}>
            <Link href={routes.deployments}>Deployments</Link>
          </Typography>
          <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h1" sx={{ fontFamily: MONO_STACK }}>
              {group.name}
            </Typography>
            <ShapePill label={isPool ? 'ABR node pool' : 'Group'} />
            <ReadinessPill label={readiness.label} tone={readiness.tone} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {members.length} members · created {formatDate(group.created_at)} ·{' '}
            {isPool
              ? 'one Bee node per quality rung, used as upload targets by an ABR uploader'
              : `${memberNoun(members)} sharing one configuration`}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ flex: 'none' }}>
          {startable && (
            <Button
              variant="contained"
              onClick={() => actions.startGroup(group, members)}
            >
              Start all
            </Button>
          )}
          {members.some(isRunning) && (
            <Button onClick={() => actions.stopGroup(group, members)}>Stop all</Button>
          )}
          {!isPool && (
            <Button onClick={() => openEditGroup(group.id)}>
              Edit shared settings
            </Button>
          )}
          <Button
            color="error"
            variant="outlined"
            onClick={() => actions.requestRemoveGroup(group, members)}
          >
            Remove group
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={2}>
        {isPool && (
          <PoolStringCard
            group={group}
            result={publishers.result}
            loading={publishers.loading}
            error={publishers.error}
            onReload={() => void publishers.reload()}
          />
        )}

        <GroupMembersCard
          group={group}
          members={members}
          isPool={isPool}
          poolResult={publishers.result}
        />

        {isPool ? (
          <SectionCard title="How a pool works">
            <Typography variant="body2" color="text.secondary">
              {POOL_EXPLAINER}
            </Typography>
          </SectionCard>
        ) : (
          <SharedSettingsCard
            group={group}
            members={members}
            serverHost={serverHost}
            streamerName={streamerName}
          />
        )}
      </Stack>
    </Box>
  );
}

function memberNoun(members: Profile[]): string {
  const first = members[0];
  if (!first) return 'members';
  return `${members.length} ${SHAPE_LABEL[shapeOf(first)].toLowerCase()}s`;
}
