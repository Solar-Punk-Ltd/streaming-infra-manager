import { useEffect } from 'react';
import { Box, Button, CircularProgress, Paper, Stack } from '@mui/material';

import {
  rungFromMemberName,
  sameBatchId,
  stampHealthFrom,
  suggestedRungDepth,
} from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes, type DeploymentFocus } from '../app/router';
import { useActions } from '../app/useDeploymentActions';
import { useDeployments } from '../app/useDeploymentsStore';
import { EmptyState } from '../components/EmptyState';
import { useMetrics } from '../useMetrics';
import { useBeeUtils, type BeeUtils } from '../uploaders/useBeeUtils';
import type { Profile } from '../types';
import { clientUrl, srtPublishUrl } from '../urls';
import { AtAGlanceCard } from './AtAGlanceCard';
import {
  buildChecklist,
  streamerFor,
  type ChecklistInput,
  type StepAction,
} from './checklist';
import { readySummary } from './readySummary';
import { ConfigurationCard } from './ConfigurationCard';
import { ContainersCard } from './ContainersCard';
import { DeploymentHeader } from './DeploymentHeader';
import { LastErrorCard } from './LastErrorCard';
import { NextStepsCard } from './NextStepsCard';
import { NotesCard } from './NotesCard';
import { PoolTargetCard } from './PoolTargetCard';
import { PublishCard } from './PublishCard';
import { ReadinessCard } from './ReadinessCard';
import { RemoveCard } from './RemoveCard';
import { isStreamLike, readinessOf } from './readiness';
import { StorageCard } from './StorageCard';
import { isRunning, shapeOf, streamersOf } from './shape';
import { WatchCard } from './WatchCard';

const STORAGE_ANCHOR = 'storage';

export function DeploymentPage({
  name,
  focus,
}: {
  name: string;
  focus: DeploymentFocus;
}) {
  const { profiles } = useDeployments();
  const profile = profiles?.find((entry) => entry.name === name) ?? null;

  if (!profiles) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!profile) {
    return (
      <Paper>
        <EmptyState
          title={`No deployment called ${name}.`}
          hint="It may have been removed. The list has everything this manager knows about."
          action={
            <Button variant="contained" onClick={() => navigate(routes.deployments)}>
              Back to deployments
            </Button>
          }
        />
      </Paper>
    );
  }

  // The hook has to run unconditionally, so the two cases are two components
  // rather than one with a conditional call. A viewer has no Bee node to ask,
  // and asking anyway would put a node-unreachable banner on every viewer page.
  const shape = shapeOf(profile);
  return isStreamLike(profile, shape) || shape === 'bee-node' ? (
    <WithBeeNode profile={profile} focus={focus} />
  ) : (
    <DeploymentBody profile={profile} focus={focus} bee={null} />
  );
}

function WithBeeNode({
  profile,
  focus,
}: {
  profile: Profile;
  focus: DeploymentFocus;
}) {
  const bee = useBeeUtils(profile);
  return <DeploymentBody profile={profile} focus={focus} bee={bee} />;
}

function DeploymentBody({
  profile,
  focus,
  bee,
}: {
  profile: Profile;
  focus: DeploymentFocus;
  bee: BeeUtils | null;
}) {
  const { profiles, groups, serverHost, hostPassphrase, reload } = useDeployments();
  const actions = useActions();
  const { openEditDeployment } = useEditors();
  const { snapshot } = useMetrics();

  useEffect(() => {
    if (focus !== 'storage') return;
    const target = document.getElementById(STORAGE_ANCHOR);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, profile.name]);

  const shape = shapeOf(profile);
  const group = groups.find((entry) => entry.id === profile.group_id) ?? null;
  const rung = group ? rungFromMemberName(group.name, profile.name) : null;
  const stampHealth = stampHealthFrom(profile.stamp_id, bee?.stamps ?? null);
  const stampId = profile.stamp_id;
  const currentStamp =
    (stampId &&
      bee?.stamps?.find((stamp) => sameBatchId(stamp.batchID, stampId))) ||
    null;

  const publishUrl = srtPublishUrl(profile, serverHost, hostPassphrase);
  const watchUrl = clientUrl(profile, serverHost);
  const streamers = streamersOf(profiles ?? []);
  const streamer = streamerFor(profile.feed_owner, streamers);

  const checklistInput: ChecklistInput = {
    profile,
    wallet: bee?.wallet ?? null,
    nodeAddress: bee?.address?.ethereum ?? null,
    stampHealth,
    currentStamp,
    publishUrl,
    clientUrl: watchUrl,
    streamers,
  };

  const steps = buildChecklist(checklistInput);
  const summary = readySummary(checklistInput, stampHealth);
  const readiness = readinessOf(profile, stampHealth);
  const uploaderPending = Boolean(profile.pendingStamp);

  const runStepAction = (action: StepAction) => {
    switch (action.kind) {
      case 'start':
        actions.start(profile.name);
        return;
      case 'copy-address':
        if (action.value) {
          void navigator.clipboard.writeText(action.value).catch(() => undefined);
        }
        return;
      case 'buy-stamp':
        document
          .getElementById(STORAGE_ANCHOR)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      case 'deploy-uploader':
        actions.startUploader(profile.name);
        return;
      case 'edit':
        openEditDeployment(profile.name);
        return;
      case 'open-stream':
        if (action.value) navigate(routes.deployment(action.value));
        return;
    }
  };

  return (
    <Box>
      <DeploymentHeader
        profile={profile}
        serverHost={serverHost}
        group={group}
        rung={rung}
        publishUrl={publishUrl}
        publishUrlReady={readiness.tone === 'ok'}
      />

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 300px' },
          alignItems: 'start',
        }}
      >
        <Stack spacing={2}>
          {profile.last_error && (
            <LastErrorCard
              message={profile.last_error}
              at={profile.last_error_at}
            />
          )}

          <ReadinessCard steps={steps} summary={summary} onAction={runStepAction} />

          {publishUrl && (
            <PublishCard
              profile={profile}
              url={publishUrl}
              hostPassphrase={hostPassphrase}
              ready={readiness.tone === 'ok'}
            />
          )}

          {watchUrl && (
            <WatchCard
              url={watchUrl}
              feedOwner={profile.feed_owner}
              streamerName={streamer?.name ?? null}
            />
          )}

          {bee && (
            <StorageCard
              profile={profile}
              bee={bee}
              stampHealth={stampHealth}
              defaultDepth={rung ? suggestedRungDepth(rung) : undefined}
              onChanged={reload}
            />
          )}

          {shape === 'abr-uploader' && <PoolTargetCard profile={profile} />}

          <ContainersCard
            profile={profile}
            host={serverHost}
            snapshot={snapshot}
            uploaderPending={uploaderPending}
          />

          <ConfigurationCard
            profile={profile}
            serverHost={serverHost}
            hostPassphrase={hostPassphrase}
            streamerName={streamer?.name ?? null}
            stampHealth={stampHealth}
          />

          <RemoveCard profile={profile} />
        </Stack>

        <Stack spacing={2}>
          <AtAGlanceCard
            profile={profile}
            serverHost={serverHost}
            readiness={readiness}
            stampHealth={stampHealth}
            group={group}
          />
          {shape === 'stream' && isRunning(profile) && (
            <NextStepsCard streamName={profile.name} />
          )}
          <NotesCard name={profile.name} notes={profile.notes} />
        </Stack>
      </Box>
    </Box>
  );
}
