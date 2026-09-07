import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { addUser } from '../auth/authApi';
import { PASSWORD_MISMATCH, PASSWORD_RULE } from '../auth/messages';
import { SectionCard } from '../components/SectionCard';

const EMPTY = { username: '', password: '', again: '' };

/**
 * Adding someone. The password is typed twice and handed over in person, and
 * the new user is expected to change it from their own Access page.
 */
export function AddUserCard({ onAdded }: { onAdded: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (field: keyof typeof EMPTY, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;

    if (form.password !== form.again) {
      setError(PASSWORD_MISMATCH);
      return;
    }

    setPending(true);
    setError(null);
    try {
      await addUser(form.username.trim(), form.password, admin);
      setForm(EMPTY);
      setAdmin(false);
      toast(`Added ${form.username.trim()}`, 'success');
      await onAdded();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const complete =
    form.username.trim() !== '' && form.password !== '' && form.again !== '';

  return (
    <SectionCard title="Add user">
      <Stack spacing={2} component="form" onSubmit={submit}>
        <Typography variant="body2" color="text.secondary">
          Type a starting password, tell it to them in person, and ask them to
          change it here once they are in.
        </Typography>

        <TextField
          label="Username"
          name="username"
          value={form.username}
          onChange={(event) => set('username', event.target.value)}
          helperText="Lower case letters, digits, dot, underscore or dash."
          autoComplete="off"
          disabled={pending}
          slotProps={{
            htmlInput: {
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
            },
          }}
          fullWidth
        />
        <TextField
          label="Password"
          name="new-password"
          type="password"
          value={form.password}
          onChange={(event) => set('password', event.target.value)}
          helperText={PASSWORD_RULE}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />
        <TextField
          label="Password again"
          name="new-password-again"
          type="password"
          value={form.again}
          onChange={(event) => set('again', event.target.value)}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={admin}
              onChange={(event) => setAdmin(event.target.checked)}
              disabled={pending}
            />
          }
          label="Can manage users: add and remove them, sign anyone out"
        />

        {error && <Alert severity="error">{error}</Alert>}

        <Stack direction="row" justifyContent="flex-end">
          <Button type="submit" variant="contained" disabled={pending || !complete}>
            {pending ? 'Adding' : 'Add user'}
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
