import { Button, Stack, TextField, Typography } from '@mui/material';

import {
  generateSrtPassphrase,
  SRT_PASSPHRASE_MESSAGE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import type { WizardStepProps } from '../wizardState';

/** The SRT passphrase question, for every goal that runs the SRS engine. */
export function PassphraseChoice({ state, context, update }: WizardStepProps) {
  const hostDetail = context.hostPassphrase
    ? 'The host has a shared passphrase, so streams are encrypted either way.'
    : 'The host has no shared passphrase, so this would publish unencrypted.';

  return (
    <FormField label="SRT passphrase" aside="protects the ingest">
      <ChoiceGroup
        name="wizard-passphrase"
        value={state.passMode}
        onChange={(passMode) => update({ passMode })}
        choices={[
          {
            value: 'host',
            title: 'Use the host-wide passphrase',
            detail: hostDetail,
          },
          {
            value: 'generate',
            title: 'Generate one for this deployment',
            detail: 'Recommended when several people publish to this host.',
            extra: (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography
                  variant="caption"
                  sx={{ fontFamily: MONO_STACK, wordBreak: 'break-all', flex: 1 }}
                >
                  {state.generatedPassphrase}
                </Typography>
                <Button
                  size="small"
                  onClick={() => update({ generatedPassphrase: generateSrtPassphrase() })}
                >
                  Regenerate
                </Button>
              </Stack>
            ),
          },
          {
            value: 'custom',
            title: 'Type my own',
            detail: `It ${SRT_PASSPHRASE_MESSAGE}.`,
            extra: (
              <TextField
                size="small"
                fullWidth
                value={state.ownPassphrase}
                onChange={(event) => update({ ownPassphrase: event.target.value })}
                placeholder="my-stage-passphrase-2026"
                inputProps={{ style: { fontFamily: MONO_STACK } }}
              />
            ),
          },
        ]}
      />
    </FormField>
  );
}
