import { useState } from 'react';
import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';

import { settingValueProblem, type StackSettingsEntry } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';

import { isAtSampleValue } from './settingsDraft';

const GENERATED_NOTE =
  'Set per deployment by the manager unless you set a value here.';

/**
 * One key of a version's env file: what it is called, what the version's
 * sample says about it, and the value this host gives it.
 *
 * A secret is masked until the operator asks to see it. That is a shoulder
 * guard rather than a secrecy boundary: the value arrived in the response and
 * the session already holds it. Nothing here ever writes a value to the
 * console.
 */
export function SettingsEntryField({
  entry,
  value,
  disabled,
  onChange,
}: {
  entry: StackSettingsEntry;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const atSample = isAtSampleValue({ value, sampleValue: entry.sampleValue });
  // The manager's own rule, so the field says what a save would be refused for
  // before the save goes out.
  const problem = settingValueProblem(entry.key, value);

  return (
    <Box component="li" sx={{ listStyle: 'none', py: 1.5, borderTop: 1, borderColor: 'divider' }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="body2" sx={{ fontFamily: MONO_STACK, fontWeight: 600, wordBreak: 'break-all' }}>
          {entry.key}
        </Typography>
        {atSample && <Chip size="small" variant="outlined" label="default" />}
        {entry.generated && <Chip size="small" variant="outlined" color="info" label="generated" />}
      </Stack>

      {entry.description && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {entry.description}
        </Typography>
      )}
      {entry.generated && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {GENERATED_NOTE}
        </Typography>
      )}

      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ minWidth: 0 }}>
        <TextField
          size="small"
          fullWidth
          value={value}
          disabled={disabled}
          type={entry.secret && !revealed ? 'password' : 'text'}
          error={problem !== null}
          helperText={problem === null ? undefined : `This value ${problem}`}
          onChange={(event) => onChange(event.target.value)}
          inputProps={{
            'aria-label': entry.key,
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            style: { fontFamily: MONO_STACK, fontSize: 13 },
          }}
        />
        {entry.secret && (
          <Button
            size="small"
            sx={{ flex: 'none', mt: 0.25 }}
            aria-label={`${revealed ? 'Hide' : 'Reveal'} ${entry.key}`}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
