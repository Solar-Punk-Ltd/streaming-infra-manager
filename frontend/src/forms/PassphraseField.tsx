import { useState } from 'react';
import { Button, Stack, TextField } from '@mui/material';

import {
  generateSrtPassphrase,
  SRT_PASSPHRASE_MESSAGE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { ChoiceGroup } from './ChoiceGroup';
import { srtPassphraseMasked } from './deploymentEdits';
import { FormField } from './FormField';
import { passphraseProblem } from './validation';

/** Where a deployment's SRT passphrase comes from, in an edit drawer. */
export type PassphraseMode = 'host' | 'own';

const MASK = '••••••••';

const HINT =
  'Publishers must use the new passphrase after the redeploy. The publish URL updates itself.';

/**
 * The passphrase question as the edit drawers ask it: the host-wide one, or
 * this deployment's own.
 *
 * The host-wide option is what clears a passphrase, so it has to be a choice
 * rather than an empty field. An empty field reads as "no passphrase at all",
 * which is not what the host-wide default does.
 *
 * A stored passphrase is shown as dots and never in full, because it is not
 * here to show: the row says only whether one is stored, and the value is
 * answered to the page that puts it in a publish URL.
 */
export function PassphraseField({
  mode,
  value,
  hasStoredPassphrase,
  appliesToAll = false,
  onModeChange,
  onValueChange,
}: {
  mode: PassphraseMode;
  value: string;
  /** Whether the deployment holds one, so an untouched field stays masked. */
  hasStoredPassphrase: boolean;
  /** A group drawer says so, because the change lands on every member. */
  appliesToAll?: boolean;
  onModeChange: (next: PassphraseMode) => void;
  onValueChange: (next: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const masked = srtPassphraseMasked({
    hasStoredPassphrase,
    typed: value,
    replacing,
  });
  const problem = mode === 'own' && !masked ? passphraseProblem(value) : null;

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
                  value={masked ? MASK : value}
                  disabled={masked}
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
                {masked && (
                  <Button
                    size="small"
                    onClick={() => setReplacing(true)}
                    sx={{ flex: 'none' }}
                  >
                    Type another
                  </Button>
                )}
              </Stack>
            ),
          },
        ]}
      />
    </FormField>
  );
}
