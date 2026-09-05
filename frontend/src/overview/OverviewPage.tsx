import {
  Box,
  Button,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';

import { isLadderKind } from '@streaming-infra-manager/common';

import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useDeployments } from '../app/useDeploymentsStore';
import { EmptyState } from '../components/EmptyState';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import { StatusDot } from '../components/StatusDot';
import { needsAttention, readinessOf } from '../deployments/readiness';
import { isRunning, SHAPE_LABEL, shapeOf, statusLabelOf } from '../deployments/shape';
import { usePoolResults } from '../groups/useBeePublishers';
import { useServerHost } from '../ServerHostContext';
import type { Profile } from '../types';
import { srtPublishUrl } from '../urls';
import { useMetrics } from '../useMetrics';
import { ActivityCard } from './ActivityCard';
import { AttentionList, type PoolAlert } from './AttentionList';
import { HostCard } from './HostCard';

export function OverviewPage() {
  const { profiles, groups, activity, hostPassphrase } = useDeployments();
  const serverHost = useServerHost();
  const { snapshot } = useMetrics();
  const poolResults = usePoolResults(groups, profiles);

  if (!profiles) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const attention = profiles.filter((profile) => needsAttention(profile));
  const poolAlerts: PoolAlert[] = groups
    .filter((group) => isLadderKind(group.kind))
    .map((group) => ({ group, result: poolResults.get(group.id) ?? null }))
    .filter(({ result }) => result !== null && !result.ready);

  const streams = profiles.filter((profile) =>
    ['stream', 'abr-uploader'].includes(shapeOf(profile)),
  );

  const counts = {
    running: profiles.filter(isRunning).length,
    attention: attention.length,
    stopped: profiles.filter((profile) => profile.status === 'STOPPED').length,
  };

  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
          alignItems: 'start',
        }}
      >
        <HostCard snapshot={snapshot} serverHost={serverHost} />
        <SectionCard
          title="Deployments"
          actions={
            <Button size="small" onClick={() => navigate(routes.deployments)}>
              All
            </Button>
          }
        >
          <Stack direction="row" spacing={3}>
            <Count label="Running" value={counts.running} color="success.main" />
            <Count
              label="Need attention"
              value={counts.attention}
              color={counts.attention ? 'warning.main' : 'text.primary'}
            />
            <Count label="Stopped" value={counts.stopped} color="text.secondary" />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.75, display: 'block' }}>
            {mixLine(profiles, groups.filter((g) => isLadderKind(g.kind)).length, groups.filter((g) => !isLadderKind(g.kind)).length)}
          </Typography>
        </SectionCard>
      </Box>

      <AttentionList profiles={attention} pools={poolAlerts} />

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
          alignItems: 'start',
        }}
      >
        <SectionCard title="Streams" sub="where to publish" flush>
          {streams.length === 0 ? (
            <EmptyState
              title="No streams yet."
              hint="A stream takes a feed from OBS or FFmpeg and publishes it to Swarm."
            />
          ) : (
            <Table>
              <TableBody>
                {streams.map((profile) => (
                  <StreamRow
                    key={profile.name}
                    profile={profile}
                    publishUrl={srtPublishUrl(profile, serverHost, hostPassphrase)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <ActivityCard entries={activity} />
      </Box>
    </Stack>
  );
}

function StreamRow({
  profile,
  publishUrl,
}: {
  profile: Profile;
  publishUrl: string | null;
}) {
  const readiness = readinessOf(profile);
  const copyable = publishUrl && readiness.tone === 'ok' ? publishUrl : null;

  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer' }}
      onClick={() => navigate(routes.deployment(profile.name))}
    >
      <TableCell sx={{ width: 28 }}>
        <StatusDot tone={statusLabelOf(profile).tone} />
      </TableCell>
      <TableCell>
        <Typography sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
          {profile.name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {SHAPE_LABEL[shapeOf(profile)]}
        </Typography>
      </TableCell>
      <TableCell>
        <ReadinessPill label={readiness.label} tone={readiness.tone} />
      </TableCell>
      <TableCell align="right" onClick={(event) => event.stopPropagation()}>
        {copyable && (
          <Button
            size="small"
            onClick={() => {
              void navigator.clipboard.writeText(copyable).catch(() => undefined);
            }}
          >
            Copy publish URL
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function Count({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 26, fontWeight: 600, color }}>{value}</Typography>
    </Box>
  );
}

function mixLine(
  profiles: Profile[],
  poolCount: number,
  groupCount: number,
): string {
  const by = (shape: string) =>
    profiles.filter((profile) => shapeOf(profile) === shape).length;
  return [
    plural(by('stream'), 'stream'),
    plural(by('viewer'), 'viewer'),
    plural(by('abr-uploader'), 'ABR uploader'),
    plural(poolCount, 'node pool'),
    plural(groupCount, 'group'),
  ].join(' · ');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
