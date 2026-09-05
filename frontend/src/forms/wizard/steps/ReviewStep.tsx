import { Box, Paper, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { DEFAULT_ABR_RUNGS } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import { KeyValueList, type KeyValueEntry } from '../../../components/KeyValueList';
import { ServiceChip } from '../../../components/ServiceChip';
import { shortHex } from '../../../format';
import { GOALS } from '../wizardGoals';
import {
  chosenComponents,
  hostLabel,
  needsFeedOwner,
  needsPassphrase,
  needsStreamKey,
  poolsIn,
  usesExternalBee,
  type WizardGoal,
  type WizardStepProps,
} from '../wizardState';

const WHAT_HAPPENS_NEXT: Record<WizardGoal, string> = {
  stream: 'Containers start now and the uploader starts with them. The OBS URL appears on the deployment page.',
  viewer:
    'The player is ready as soon as the containers are up. Its link appears on the deployment page.',
  'abr-pool':
    'Four nodes start. Fund each and buy its stamp from the pool page. When all four are stamped the pool string can be copied.',
  'abr-uploader':
    'Containers start now and the OBS URL appears on the deployment page.',
  custom: 'Containers start now.',
};

const STREAM_WAITS_FOR_STAMP =
  'Containers start now. The uploader is held back until you fund the node and buy a stamp, both from the deployment page. Then the OBS URL is ready.';

export function ReviewStep({ state, context }: WizardStepProps) {
  const goal = GOALS.find((entry) => entry.id === state.goal);
  if (!goal || !state.goal) return null;

  const entries: KeyValueEntry[] = [
    { key: 'What', value: goal.title },
    { key: 'Name', value: <NameSummary state={state} /> },
    { key: 'Host', value: <Mono>{hostLabel(state, context)}</Mono> },
    {
      key: 'Components',
      value: (
        <Stack direction="row" spacing={0.5} flexWrap="wrap">
          {chosenComponents(state).map((service) => (
            <ServiceChip key={service} service={service} />
          ))}
        </Stack>
      ),
    },
  ];

  if (needsPassphrase(state)) {
    entries.push({ key: 'SRT passphrase', value: passphraseSummary(state.passMode) });
  }
  if (needsStreamKey(state)) {
    entries.push({
      key: 'Stream key',
      value:
        state.keyMode === 'generate'
          ? 'new key, generated in the browser'
          : 'existing key',
    });
  }
  if (state.goal === 'stream') {
    entries.push({
      key: 'Postage stamp',
      value:
        state.stampMode === 'later' ? (
          'buy after deploying, the uploader waits for it'
        ) : (
          <Mono>{shortHex(state.stampId)}</Mono>
        ),
    });
    entries.push({
      key: 'Bee node',
      value: usesExternalBee(state) ? (
        <span>
          external <Mono>{state.beeUrl}</Mono>
        </span>
      ) : (
        'its own node'
      ),
    });
  }
  if (needsFeedOwner(state)) {
    entries.push({
      key: 'Follows',
      value:
        state.feedMode === 'pick' ? (
          <span>
            <Mono>{state.feedStreamer}</Mono> on this manager
          </span>
        ) : (
          <Mono>{shortHex(state.feedOwner)}</Mono>
        ),
    });
  }
  if (state.goal === 'abr-uploader') {
    const pool = poolsIn(context).find((entry) => entry.id === state.poolId);
    entries.push({
      key: 'Publishes to',
      value:
        state.poolMode === 'pick' ? (
          <span>
            pool <Mono>{pool?.name ?? 'none'}</Mono> on this manager
          </span>
        ) : (
          'a pool on another manager, from the pasted string'
        ),
    });
  }
  if (state.notes.trim()) {
    entries.push({ key: 'Notes', value: state.notes.trim() });
  }

  const next =
    state.goal === 'stream' && state.stampMode === 'later'
      ? STREAM_WAITS_FOR_STAMP
      : WHAT_HAPPENS_NEXT[state.goal];

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6" component="h4">
          Review
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Check it, then deploy.
        </Typography>
      </Box>
      <Paper sx={{ p: 2 }}>
        <KeyValueList entries={entries} labelWidth={150} />
      </Paper>
      <Box
        sx={(theme) => ({
          border: 1,
          borderRadius: 2,
          p: 1.5,
          borderColor: `rgba(${theme.vars.palette.success.mainChannel} / 0.28)`,
          backgroundColor: `rgba(${theme.vars.palette.success.mainChannel} / 0.1)`,
        })}
      >
        <Typography variant="body2">
          <strong>What happens next.</strong> {next}
        </Typography>
      </Box>
    </Stack>
  );
}

function passphraseSummary(mode: string): string {
  if (mode === 'host') return 'the host-wide passphrase';
  return mode === 'generate'
    ? 'generated for this deployment'
    : 'a passphrase of your own';
}

function NameSummary({ state }: { state: WizardStepProps['state'] }) {
  const suffix =
    state.goal === 'abr-pool'
      ? `4 members: ${DEFAULT_ABR_RUNGS.map((rung) => `${state.name}-${rung}`).join(', ')}`
      : state.group
        ? `${state.size} members`
        : null;

  return (
    <span>
      <Mono>{state.name}</Mono>
      {suffix && (
        <Typography component="span" variant="caption" color="text.secondary">
          {' '}
          ({suffix})
        </Typography>
      )}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ fontFamily: MONO_STACK }}>
      {children}
    </Box>
  );
}
