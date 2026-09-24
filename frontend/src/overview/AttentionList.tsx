import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

import {
  type BeePublishersResult,
  type ChequebookHealth,
  type StampHealth,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { StatusDot } from '../components/StatusDot';
import type { Tone } from '../components/tone';
import { poolProblems } from '../groups/groupReadiness';
import type { StampHealths } from '../uploaders/useStampHealths';
import { readinessOf } from '../deployments/readiness';
import type { UploaderHealths } from '../deployments/useUploaderHealths';
import type { DeploymentGroup, Profile } from '../types';
import type { ChequebookHealths } from '../uploaders/useChequebookHealths';
import { type AttentionAction, attentionText } from './attentionText';

export interface PoolAlert {
  group: DeploymentGroup;
  result: BeePublishersResult | null;
}

/** Everything that needs a hand, each with the button that fixes it. */
export function AttentionList({
  profiles,
  pools,
  chequebooks,
  stampHealths,
  uploaderHealths,
}: {
  profiles: Profile[];
  pools: PoolAlert[];
  /** What each node said about its chequebook, for the nodes that answered. */
  chequebooks: ChequebookHealths;
  /**
   * What the page holds about each member's batch: the pool assembly's reading
   * where there is one, else its own poll of the node.
   */
  stampHealths: StampHealths;
  /** What each running uploader said about itself, where the manager could ask it. */
  uploaderHealths: UploaderHealths;
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
            <ProfileAlertRow
              key={profile.name}
              profile={profile}
              chequebook={chequebooks.get(profile.name) ?? null}
              stampHealth={stampHealths.get(profile.name)}
              uploaderHealth={uploaderHealths.get(profile.name)}
            />
          ))}
          {pools.map(({ group, result }) => (
            <AlertRow
              key={group.id}
              tone="warn"
              name={group.name}
              text={`Node pool not ready: ${poolProblems(result, chequebooks).join(', ') || 'a rung is not ready'}. The pool string cannot be copied yet.`}
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

function ProfileAlertRow({
  profile,
  chequebook,
  stampHealth,
  uploaderHealth,
}: {
  profile: Profile;
  chequebook: ChequebookHealth | null;
  stampHealth?: StampHealth;
  uploaderHealth?: UploaderHealthReading;
}) {
  const actions = useActions();
  const { openEditDeployment } = useEditors();
  const readiness = readinessOf(profile, stampHealth, chequebook, { uploaderHealth });

  const openStorage = () => navigate(routes.deploymentStorage(profile.name));
  const buttons: Record<AttentionAction, ReactNode> = {
    retry: (
      <Button
        size="small"
        variant="contained"
        onClick={() => actions.start(profile.name)}
      >
        Retry
      </Button>
    ),
    'start-uploader': (
      <Button
        size="small"
        variant="contained"
        onClick={() => actions.startUploader(profile.name)}
      >
        Start uploader
      </Button>
    ),
    'buy-stamp': (
      <Button size="small" variant="contained" onClick={openStorage}>
        Buy stamp
      </Button>
    ),
    'fill-chequebook': (
      <Button size="small" variant="contained" onClick={openStorage}>
        Fill chequebook
      </Button>
    ),
    edit: (
      <Button size="small" onClick={() => openEditDeployment(profile.name)}>
        Edit
      </Button>
    ),
  };

  const { text, action } = attentionText(readiness.label, profile, chequebook, uploaderHealth);

  return (
    <AlertRow
      tone={readiness.tone}
      name={profile.name}
      text={text}
      action={action ? buttons[action] : null}
      onOpen={() => navigate(routes.deployment(profile.name))}
    />
  );
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
