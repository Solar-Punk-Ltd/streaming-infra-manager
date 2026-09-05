import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

import type { BeePublishersResult } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { StatusDot } from '../components/StatusDot';
import type { Tone } from '../components/tone';
import { poolProblems } from '../groups/groupReadiness';
import {
  NEEDS_A_STAMP,
  POOL_STRING_INVALID,
  readinessOf,
  STAMP_ENDS_SOON,
  STAMP_EXPIRED,
  UPLOADER_NOT_STARTED,
} from '../deployments/readiness';
import { shapeOf } from '../deployments/shape';
import type { DeploymentGroup, Profile } from '../types';

export interface PoolAlert {
  group: DeploymentGroup;
  result: BeePublishersResult | null;
}

/** Everything that needs a hand, each with the button that fixes it. */
export function AttentionList({
  profiles,
  pools,
}: {
  profiles: Profile[];
  pools: PoolAlert[];
}) {
  const total = profiles.length + pools.length;

  return (
    <SectionCard
      title="Needs attention"
      sub={total ? `${total} ${total === 1 ? 'item' : 'items'}` : 'nothing right now'}
      flush
    >
      {total === 0 ? (
        <EmptyState
          title="Everything is running and ready."
          hint="Anything that stops, fails or runs out of postage appears here."
        />
      ) : (
        <Box>
          {profiles.map((profile) => (
            <ProfileAlertRow key={profile.name} profile={profile} />
          ))}
          {pools.map(({ group, result }) => (
            <AlertRow
              key={group.id}
              tone="warn"
              name={group.name}
              text={`Node pool not ready: ${poolProblems(result).join(', ') || 'a rung is not ready'}. The pool string cannot be copied yet.`}
              action={
                <Button size="small" onClick={() => navigate(routes.group(group.id))}>
                  Open pool
                </Button>
              }
            />
          ))}
        </Box>
      )}
    </SectionCard>
  );
}

function ProfileAlertRow({ profile }: { profile: Profile }) {
  const actions = useActions();
  const { openEditDeployment } = useEditors();
  const readiness = readinessOf(profile);

  const buyStamp = (
    <Button
      size="small"
      variant="contained"
      onClick={() => navigate(routes.deploymentStorage(profile.name))}
    >
      Buy stamp
    </Button>
  );

  const { text, action } = describe(readiness.label, profile, {
    retry: (
      <Button
        size="small"
        variant="contained"
        onClick={() => actions.start(profile.name)}
      >
        Retry
      </Button>
    ),
    startUploader: (
      <Button
        size="small"
        variant="contained"
        onClick={() => actions.startUploader(profile.name)}
      >
        Start uploader
      </Button>
    ),
    buyStamp,
    edit: (
      <Button size="small" onClick={() => openEditDeployment(profile.name)}>
        Edit
      </Button>
    ),
  });

  return (
    <AlertRow
      tone={readiness.tone}
      name={profile.name}
      text={text}
      action={action}
      onOpen={() => navigate(routes.deployment(profile.name))}
    />
  );
}

interface AlertButtons {
  retry: ReactNode;
  startUploader: ReactNode;
  buyStamp: ReactNode;
  edit: ReactNode;
}

function describe(
  label: string,
  profile: Profile,
  buttons: AlertButtons,
): { text: string; action: ReactNode } {
  if (profile.status === 'ERROR') {
    return {
      text: `Deploy failed. ${profile.last_error ?? 'No error was recorded.'}`,
      action: buttons.retry,
    };
  }
  switch (label) {
    case NEEDS_A_STAMP:
      return {
        text:
          shapeOf(profile) === 'bee-node'
            ? 'No stamp yet, so its pool cannot publish to this rung.'
            : 'Running, but it cannot upload until a stamp is bought and set.',
        action: buttons.buyStamp,
      };
    case STAMP_EXPIRED:
      return {
        text: 'The stamp ran out. Buy a new one to upload again.',
        action: buttons.buyStamp,
      };
    case UPLOADER_NOT_STARTED:
      return {
        text: 'Stamp is set. Start the uploader to finish the stack.',
        action: buttons.startUploader,
      };
    case STAMP_ENDS_SOON:
      return {
        text: 'Buy the next stamp before this one runs out.',
        action: buttons.buyStamp,
      };
    case POOL_STRING_INVALID:
      return {
        text: 'Its node pool string cannot be read, so the uploader will not start.',
        action: buttons.edit,
      };
    default:
      return { text: label, action: null };
  }
}

function AlertRow({
  tone,
  name,
  text,
  action,
  onOpen,
}: {
  tone: Tone;
  name: string;
  text: string;
  action: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      sx={{ px: 2.25, py: 1.5, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0 } }}
    >
      <StatusDot tone={tone} />
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
          {name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {text}
        </Typography>
      </Box>
      {action}
      {onOpen && (
        <Button size="small" onClick={onOpen}>
          Open
        </Button>
      )}
    </Stack>
  );
}
