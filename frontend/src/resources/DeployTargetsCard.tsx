import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import { getErrorMessage, type DeployTargetsView } from '@streaming-infra-manager/common';

import { SectionCard } from '../components/SectionCard';
import { formatDateTime } from '../format';
import { apiFetch, failWith } from '../http';

export function DeployTargetsCard() {
  const [data, setData] = useState<DeployTargetsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);

  async function load(signal: AbortSignal) {
    const response = await apiFetch('/targets', { signal });
    if (!response.ok) await failWith(response, 'Could not read deploy targets.');
    const next = await response.json() as DeployTargetsView;
    if (!signal.aborted) setData(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void load(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(getErrorMessage(caught));
    });
    return () => request.current?.abort();
  }, []);

  async function refresh(verify?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (verify) {
        const response = await apiFetch('/targets/verify', {
          method: 'POST', body: { alias: verify }, signal: controller.signal,
        });
        if (!response.ok) await failWith(response, 'Could not verify this target.');
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(getErrorMessage(caught));
    } finally {
      if (!controller.signal.aborted) {
        try { await load(controller.signal); }
        catch (caught) { if (!controller.signal.aborted) setError(getErrorMessage(caught)); }
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  return (
    <SectionCard
      title="Deploy targets"
      sub="Targets that reach the same Docker daemon share port reservations"
      actions={<Button size="small" disabled={busy} onClick={() => void refresh()}>Refresh</Button>}
    >
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        {data && !data.inventorySeededAt && (
          <Alert severity="warning">The reservation inventory is still being built. New deployments wait until existing deployments have been accounted for.</Alert>
        )}
        {!data && !error && <Typography color="text.secondary">Loading targets…</Typography>}
        {data?.targets.map((target) => (
          <Stack key={target.alias} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography>{target.alias}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                Docker daemon: {target.daemonId ?? 'not established'}
              </Typography>
              <Typography variant="caption" color={target.verifiedAt ? 'text.secondary' : 'error.main'}>
                {target.verifiedAt ? `Verified ${formatDateTime(target.verifiedAt)}` : 'Not verified'}
              </Typography>
              {target.lastError && <Typography variant="body2" color="error.main">{target.lastError}</Typography>}
            </Stack>
            <Button disabled={busy} onClick={() => void refresh(target.alias)} aria-label={`Verify ${target.alias}`}>Verify</Button>
          </Stack>
        ))}
        <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1}
          onSubmit={(event) => { event.preventDefault(); if (alias.trim() && !busy) void refresh(alias.trim()); }}>
          <TextField label="Deploy target" value={alias} onChange={(event) => setAlias(event.target.value)}
            helperText="Use the same SSH alias or user@host as the deployment." size="small" fullWidth />
          <Button type="submit" disabled={busy || !alias.trim()} sx={{ alignSelf: 'flex-start' }}>Verify target</Button>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
