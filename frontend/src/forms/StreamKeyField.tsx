import { Button, Stack, TextField, Typography } from '@mui/material';
import { generatePrivateKey } from 'viem/accounts';

import { MONO_STACK } from '../app/theme';
import { shortHex } from '../format';
import { FormField } from './FormField';
import { addressForKey, privateKeyProblem } from './validation';

const MASK = '••••••••';

const IDENTITY_WARNING =
  'Changing the key changes the stream identity. Viewers following the old address stop seeing it.';

/**
 * The private key that signs a stream's feed, in an edit drawer.
 *
 * A key that came from the server is shown as dots and never in full: it is on
 * screen every time anyone opens the drawer to change a note, and the address
 * is the part that is worth reading anyway. A key generated here is a value
 * nobody has yet, so it is shown once, with the address it derives.
 */
export function StreamKeyField({
  value,
  storedKey,
  storedAddress,
  onChange,
}: {
  value: string;
  /** What the profile holds now, so an untouched field can stay masked. */
  storedKey: string;
  storedAddress: string | null;
  onChange: (next: string) => void;
}) {
  const unchanged = value === storedKey && storedKey !== '';
  const address = unchanged ? storedAddress : addressForKey(value);
  const problem = value.trim() && !unchanged ? privateKeyProblem(value) : null;

  return (
    <FormField
      label="Stream key"
      aside="the Ethereum private key that signs this feed"
      error={problem}
      hint={unchanged ? undefined : IDENTITY_WARNING}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            fullWidth
            value={unchanged ? MASK : value}
            disabled={unchanged}
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
          {unchanged && (
            <Button size="small" onClick={() => onChange('')} sx={{ flex: 'none' }}>
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
