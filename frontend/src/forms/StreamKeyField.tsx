import { Button, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { generatePrivateKey } from 'viem/accounts';

import { MONO_STACK } from '../app/theme';
import { shortHex } from '../format';
import { streamKeyMasked } from './deploymentEdits';
import { FormField } from './FormField';
import { addressForKey, privateKeyProblem } from './validation';

const MASK = '••••••••';

const IDENTITY_WARNING =
  'Changing the key changes the stream identity. Viewers following the old address stop seeing it.';

/**
 * The private key that signs a stream's feed, in an edit drawer.
 *
 * A stored key is shown as dots and never in full, because it is not here to
 * show: the manager answers whether one is stored and keeps the value, and the
 * address is the part that is worth reading anyway. A key generated here is a
 * value nobody has yet, so it is shown once, with the address it derives.
 */
export function StreamKeyField({
  value,
  hasStoredKey,
  storedAddress,
  onChange,
}: {
  value: string;
  /** Whether the deployment holds a key, so an untouched field stays masked. */
  hasStoredKey: boolean;
  storedAddress: string | null;
  onChange: (next: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const masked = streamKeyMasked({ hasStoredKey, typed: value, replacing });
  const address = masked ? storedAddress : addressForKey(value);
  const problem = value.trim() && !masked ? privateKeyProblem(value) : null;

  return (
    <FormField
      label="Stream key"
      aside="the Ethereum private key that signs this feed"
      error={problem}
      hint={masked ? undefined : IDENTITY_WARNING}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            fullWidth
            value={masked ? MASK : value}
            disabled={masked}
            onChange={(event) => onChange(event.target.value)}
            placeholder="0x plus 64 hex characters"
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
          <Button
            size="small"
            onClick={() => onChange(generatePrivateKey())}
            sx={{ flex: 'none' }}
          >
            {value ? 'Regenerate' : 'Generate'}
          </Button>
          {masked && (
            <Button
              size="small"
              onClick={() => setReplacing(true)}
              sx={{ flex: 'none' }}
            >
              Paste another
            </Button>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {address ? `Address ${shortHex(address)}` : 'No address yet'}
        </Typography>
      </Stack>
    </FormField>
  );
}
