import { Button, Stack, TextField, Typography } from '@mui/material';
import { generatePrivateKey } from 'viem/accounts';

import { MONO_STACK } from '../../../app/theme';
import { shortHex } from '../../../format';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { addressForKey } from '../../validation';
import type { WizardStepProps } from '../wizardState';

/**
 * Where the private key that signs this stream's feed comes from.
 *
 * A generated key is shown by its address only. The key itself is not needed
 * anywhere else, and the address is what a viewer follows.
 */
export function StreamKeyChoice({ state, update }: WizardStepProps) {
  const generatedAddress = addressForKey(state.generatedKey);

  return (
    <FormField
      label="Stream key"
      aside="the Ethereum private key that signs this feed"
    >
      <ChoiceGroup
        name="wizard-key"
        value={state.keyMode}
        onChange={(keyMode) => update({ keyMode })}
        choices={[
          {
            value: 'generate',
            title: 'Generate a new key',
            detail: 'Done in your browser. The public address is derived from it.',
            extra: (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography variant="caption" sx={{ fontFamily: MONO_STACK, flex: 1 }}>
                  address {generatedAddress ? shortHex(generatedAddress) : 'not derived'}
                </Typography>
                <Button
                  size="small"
                  onClick={() => update({ generatedKey: generatePrivateKey() })}
                >
                  Regenerate
                </Button>
              </Stack>
            ),
          },
          {
            value: 'paste',
            title: 'Use an existing key',
            detail: 'To continue an existing stream identity.',
            extra: (
              <TextField
                size="small"
                fullWidth
                value={state.pastedKey}
                onChange={(event) => update({ pastedKey: event.target.value })}
                placeholder="0x plus 64 hex characters"
                inputProps={{ style: { fontFamily: MONO_STACK } }}
              />
            ),
          },
        ]}
      />
    </FormField>
  );
}
