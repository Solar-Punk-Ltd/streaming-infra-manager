import { useState, type FormEvent } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { changePassword } from '../auth/authApi';
import { PASSWORD_MISMATCH, PASSWORD_RULE } from '../auth/messages';
import { SectionCard } from '../components/SectionCard';

const EMPTY = { current: '', next: '', again: '' };

/**
 * Changing your own password, which also signs out every other browser you
 * were signed in with. That is the point of doing it after a password leaks.
 */
export function ChangePasswordCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (field: keyof typeof EMPTY, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;

    if (form.next !== form.again) {
      setError(PASSWORD_MISMATCH);
      return;
    }

    setPending(true);
    setError(null);
    try {
      await changePassword(form.current, form.next);
      setForm(EMPTY);
      toast('Password changed. Your other browsers were signed out.', 'success');
      await onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const complete =
    form.current !== '' && form.next !== '' && form.again !== '';

  return (
    <SectionCard title="Change my password">
      <Stack spacing={2} component="form" onSubmit={submit}>
        <Typography variant="body2" color="text.secondary">
          This browser stays signed in. Every other one is signed out.
        </Typography>

        <TextField
          label="Current password"
          name="current-password"
          type="password"
          value={form.current}
          onChange={(event) => set('current', event.target.value)}
          autoComplete="current-password"
          disabled={pending}
          fullWidth
        />
        <TextField
          label="New password"
          name="new-password"
          type="password"
          value={form.next}
          onChange={(event) => set('next', event.target.value)}
          helperText={PASSWORD_RULE}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />
        <TextField
          label="New password again"
          name="new-password-again"
          type="password"
          value={form.again}
          onChange={(event) => set('again', event.target.value)}
          autoComplete="new-password"
          disabled={pending}
          fullWidth
        />

        {error && <Alert severity="error">{error}</Alert>}

        <Stack direction="row" justifyContent="flex-end">
          <Button type="submit" variant="contained" disabled={pending || !complete}>
            {pending ? 'Changing' : 'Change password'}
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
