import { useCallback, useState } from 'react';
import { Alert, Button, Link, Paper, Stack, Typography } from '@mui/material';
import { plurToBzzExact, type ChequebookOperation } from '@streaming-infra-manager/common';
import { routes } from '../app/router';
import { useSession } from '../app/useSession';
import { TransferValue } from './TransferEvidencePanel';
import { readTransferHistory, TransferHistoryError } from './transferHistoryApi';
import type { StoredTransferIntent } from './transferIntentStore';
import { useBrowserTransferStore } from './useBrowserTransferStore';
import { useTransferRead } from './useTransferRead';

export function TransferHistoryPage() {
  const { state } = useSession();
  return state.status === 'signedIn' ? <History key={state.id} accountId={state.id} /> : null;
}

function History({ accountId }: { accountId: number }) {
  return <Stack spacing={3}>
    <Stack spacing={0.75}>
      <Typography variant="h5">Transfer history</Typography>
      <Typography color="text.secondary">Chequebook transfers recorded by the manager, including removed deployments. Open a record to read its transaction evidence.</Typography>
    </Stack>
    <ManagerHistory accountId={accountId} />
    <BrowserHistory accountId={accountId} />
  </Stack>;
}

function ManagerHistory({ accountId }: { accountId: number }) {
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const load = useCallback((signal: AbortSignal) => readTransferHistory(cursor, signal), [cursor]);
  const { state, refresh } = useTransferRead(`${accountId}:history:${cursor ?? ''}`, load);
  const failed = state.status === 'failed';
  return <Stack spacing={1.5}>
    {state.status === 'loading' && <Typography role="status">Reading transfer history…</Typography>}
    {failed && <Alert severity="warning">{state.error instanceof TransferHistoryError && state.error.reason === 'invalid_response'
      ? 'The transfer history response could not be verified.' : 'Transfer history could not be read.'} Existing records may still be available. This is not an empty history.</Alert>}
    {state.status === 'ready' && <>
      {state.value.operations.length === 0 && <Typography>{cursors.length === 1 ? 'No transfers have been recorded.' : 'No transfers were returned on this page.'}</Typography>}
      {state.value.operations.map(operation => <TransferSummary key={operation.id} operation={operation} />)}
    </>}
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      <Button onClick={refresh} disabled={state.status === 'loading'}>{failed ? 'Retry history' : 'Refresh history'}</Button>
      {cursors.length > 1 && <Button onClick={() => setCursors(value => value.slice(0, -1))}>Newer transfers</Button>}
      {state.status === 'ready' && state.value.nextCursor !== null && <Button onClick={() => setCursors(value => [...value, state.value.nextCursor!])}>Older transfers</Button>}
    </Stack>
  </Stack>;
}

function TransferSummary({ operation }: { operation: ChequebookOperation }) {
  return <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={0.75}>
      <Link href={routes.transfer(operation.id)} sx={{ overflowWrap: 'anywhere', fontWeight: 600 }}>{transferAmount(operation)} · {operation.profileName}</Link>
      <Typography variant="body2">Saved status: {operation.state}</Typography>
      <TransferValue label="Created" value={operation.createdAt} />
      <TransferValue label="Request ID" value={operation.requestId} />
      <Typography variant="caption" color="text.secondary">This saved status is not a fresh transaction check.</Typography>
    </Stack>
  </Paper>;
}

function BrowserHistory({ accountId }: { accountId: number }) {
  const store = useBrowserTransferStore();
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const load = useCallback(async () => {
    if (!store) throw new Error('Browser storage unavailable');
    return store.list(accountId, { limit: 25, ...(cursor ? { cursor } : {}) });
  }, [store, accountId, cursor]);
  const { state, refresh } = useTransferRead(`${accountId}:browser:${cursor ?? ''}`, load);
  return <Stack spacing={1.5}>
    <Typography variant="h6">Saved on this browser</Typography>
    <Typography variant="body2" color="text.secondary">Requests saved by your current account on this browser. Their order follows browser storage. Some may have no manager record.</Typography>
    {state.status === 'loading' && <Typography role="status">Reading saved browser requests…</Typography>}
    {state.status === 'failed' && <Alert severity="warning">Saved browser requests could not be read. Manager history remains available.</Alert>}
    {state.status === 'ready' && <>
      {state.value.intents.length === 0 && <Typography>{state.value.nextCursor !== null
        ? 'This part of browser storage has no requests for your account. Continue to check the remaining records.'
        : cursors.length === 1 ? 'No requests are saved on this browser for this account.' : 'No further requests were found for this account.'}</Typography>}
      {state.value.intents.map(intent => <Paper key={intent.requestId} variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={0.75}>
          <Link href={routes.transferRequest(intent.requestId)} sx={{ overflowWrap: 'anywhere', fontWeight: 600 }}>{transferAmount(intent)} · {intent.profileName}</Link>
          <TransferValue label="Request ID" value={intent.requestId} />
          <TransferValue label="Saved on this browser at" value={intent.createdAt} />
        </Stack>
      </Paper>)}
    </>}
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      <Button onClick={refresh} disabled={state.status === 'loading'}>Refresh browser requests</Button>
      {cursors.length > 1 && <Button onClick={() => setCursors(value => value.slice(0, -1))}>Previous saved requests</Button>}
      {state.status === 'ready' && state.value.nextCursor !== null && <Button onClick={() => setCursors(value => [...value, state.value.nextCursor!])}>More saved requests</Button>}
    </Stack>
  </Stack>;
}

export function transferAmount(transfer: Pick<StoredTransferIntent, 'direction' | 'amountPlur'>): string {
  return `${transfer.direction === 'deposit' ? 'Fill chequebook' : 'Withdraw from chequebook'} · ${plurToBzzExact(BigInt(transfer.amountPlur))} BZZ`;
}
