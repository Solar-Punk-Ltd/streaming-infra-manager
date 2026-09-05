import {
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { NOTES_MAX } from '../../validation';
import { GOALS } from '../wizardGoals';
import { allowsGroup, namePreview, type WizardStepProps } from '../wizardState';

const LARGE_GROUP = 20;

const NAME_PLACEHOLDERS: Record<string, string> = {
  viewer: 'viewer-eu',
  'abr-pool': 'abr-pool-2',
};

export function BasicsStep({ state, context, update }: WizardStepProps) {
  const goal = GOALS.find((entry) => entry.id === state.goal);
  const nameLabel =
    state.goal === 'abr-pool' ? 'Pool name' : state.group ? 'Group name' : 'Name';

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h6" component="h4">
          Basics
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {goal?.title}
        </Typography>
      </Box>

      <FormField label={nameLabel} hint={namePreview(state)}>
        <TextField
          size="small"
          fullWidth
          autoFocus
          value={state.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder={NAME_PLACEHOLDERS[state.goal ?? ''] ?? 'main-stage'}
          inputProps={{ style: { fontFamily: MONO_STACK } }}
        />
      </FormField>

      <FormField label="Host" aside="where the containers run">
        <ChoiceGroup
          name="wizard-host"
          value={state.host}
          onChange={(host) => update({ host })}
          choices={[
            {
              value: 'this',
              title: `This machine (${context.serverHost})`,
              detail: 'Default. Ports are opened on this host.',
            },
            {
              value: 'custom',
              title: 'Another host over SSH',
              detail: 'An ssh alias or user@host that this manager can reach.',
              extra: (
                <TextField
                  size="small"
                  fullWidth
                  value={state.hostCustom}
                  onChange={(event) => update({ hostCustom: event.target.value })}
                  placeholder="deploy@10.0.0.7"
                  inputProps={{ style: { fontFamily: MONO_STACK } }}
                />
              ),
            },
          ]}
        />
      </FormField>

      {allowsGroup(state.goal) && (
        <Box>
          <FormControlLabel
            control={
              <Switch
                checked={state.group}
                onChange={(event) => update({ group: event.target.checked })}
              />
            }
            label={
              <Typography variant="body2">
                Deploy several at once as a group{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  identical members sharing one configuration
                </Typography>
              </Typography>
            }
          />
          {state.group && (
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
              <TextField
                size="small"
                label="How many"
                value={state.size}
                onChange={(event) => update({ size: event.target.value })}
                sx={{ width: 110 }}
              />
              <Typography variant="caption" color="text.secondary">
                {groupHint(state.size, state.goal)}
              </Typography>
            </Stack>
          )}
        </Box>
      )}

      <FormField label="Notes" aside="optional">
        <TextField
          size="small"
          fullWidth
          multiline
          minRows={2}
          value={state.notes}
          onChange={(event) => update({ notes: event.target.value })}
          placeholder="What is this for?"
          inputProps={{ maxLength: NOTES_MAX }}
        />
      </FormField>
    </Stack>
  );
}

function groupHint(size: string, goal: string | null): string {
  if (Number(size) > LARGE_GROUP) return 'Large group, double check before deploying.';
  return goal === 'stream'
    ? 'All members will share one stream key. Fine for fan-out tests, rarely for a real stage.'
    : '';
}
