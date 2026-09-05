import { Button, Stack, TextField } from '@mui/material';

import {
  generateSrtPassphrase,
  SRT_PASSPHRASE_MESSAGE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { ChoiceGroup } from './ChoiceGroup';
import { FormField } from './FormField';
import { passphraseProblem } from './validation';

/** Where a deployment's SRT passphrase comes from, in an edit drawer. */
export type PassphraseMode = 'host' | 'own';

const HINT =
  'Publishers must use the new passphrase after the redeploy. The publish URL updates itself.';

/**
 * The passphrase question as the edit drawers ask it: the host-wide one, or
 * this deployment's own.
 *
 * The host-wide option is what clears a passphrase, so it has to be a choice
 * rather than an empty field. An empty field reads as "no passphrase at all",
 * which is not what the host-wide default does.
 */
export function PassphraseField({
  mode,
  value,
  appliesToAll = false,
  onModeChange,
  onValueChange,
}: {
  mode: PassphraseMode;
  value: string;
  /** A group drawer says so, because the change lands on every member. */
  appliesToAll?: boolean;
  onModeChange: (next: PassphraseMode) => void;
  onValueChange: (next: string) => void;
}) {
  const problem = mode === 'own' ? passphraseProblem(value) : null;

  return (
    <FormField label="SRT passphrase" hint={HINT} error={problem}>
      <ChoiceGroup
        name="passphrase-mode"
        value={mode}
        onChange={onModeChange}
        choices={[
          {
            value: 'host',
            title: 'Use the host-wide passphrase',
            detail: `Clears any passphrase of its own.${
              appliesToAll ? ' Applied to every member.' : ''
            }`,
          },
          {
            value: 'own',
            title: 'Own passphrase',
            detail: `A passphrase for this deployment only. It ${SRT_PASSPHRASE_MESSAGE}.`,
            extra: (
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  fullWidth
                  value={value}
                  onChange={(event) => onValueChange(event.target.value)}
                  placeholder="my-stage-passphrase-2026"
                  inputProps={{ style: { fontFamily: MONO_STACK } }}
                />
                <Button
                  size="small"
                  onClick={() => onValueChange(generateSrtPassphrase())}
                  sx={{ flex: 'none' }}
                >
                  Generate
                </Button>
              </Stack>
            ),
          },
        ]}
      />
    </FormField>
  );
}
