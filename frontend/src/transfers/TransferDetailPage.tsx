import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Link, Paper, Stack, Typography } from '@mui/material';
import type { ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { routes } from '../app/router';
import { useSession } from '../app/useSession';
import { TransferEvidencePanel, TransferValue } from './TransferEvidencePanel';
import { transferAmount } from './TransferHistoryPage';
import { readTransferDetail, transferIdentity, TransferHistoryError, type TransferDetailKey } from './transferHistoryApi';
import { isExactTransfer, type ProvenTransferLink, type StoredTransferIntent } from './transferIntentStore';
import { useBrowserTransferStore } from './useBrowserTransferStore';
import { useTransferRead } from './useTransferRead';
import { TransferRecordedEvidence } from './TransferRecordedEvidence';
import { TransferRecoveryActions } from './TransferRecoveryActions';
import type { RecoveryNotice } from './useTransferRecovery';

export function TransferDetailPage({ detailKey }: { detailKey: TransferDetailKey }) {
  const { state } = useSession();
  return state.status === 'signedIn' ? <Detail key={`${state.id}:${detailKey.kind}:${detailKey.id}`} accountId={state.id} detailKey={detailKey} /> : null;
}

function agreesWithLink(link: ProvenTransferLink, detail: ChequebookOperationDetail): boolean {
  const operation = detail.operation;
  return link.operationId === operation.id && link.requestId === operation.requestId && link.chainId === operation.chainId &&
    link.nodeAddress === operation.nodeAddress && link.chequebookAddress === operation.chequebookAddress && link.tokenAddress === operation.tokenAddress;
}

function Detail({ accountId, detailKey }: { accountId: number; detailKey: TransferDetailKey }) {
  const store = useBrowserTransferStore();
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const identity = useRef<string | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    const detail = await readTransferDetail(detailKey, signal);
    let intent: StoredTransferIntent | null = null;
    let link: ProvenTransferLink | null = null;
    let browserUnavailable = false;
    try {
      if (!store) throw new Error('Browser storage unavailable');
      const requestId = detail?.operation.requestId ?? (detailKey.kind === 'request' ? detailKey.id : null);
      if (requestId) {
        const found = await store.find(requestId);
        intent = found?.accountId === accountId ? found : null;
        const links = intent ? await store.links(requestId) : null;
        link = links?.own?.accountId === accountId ? links.own : null;
      }
    } catch { browserUnavailable = true; }
    if (signal.aborted) throw new Error('Read cancelled');
    if (detail) {
      const nextIdentity = transferIdentity(detail.operation);
      if ((identity.current !== null && identity.current !== nextIdentity) || (intent && !isExactTransfer(intent, detail.operation)) ||
          (link && !agreesWithLink(link, detail))) throw new TransferHistoryError('identity_conflict');
      identity.current = nextIdentity;
    }
    return { detail, intent, browserUnavailable };
  }, [detailKey, store, accountId]);
  const { state, refresh } = useTransferRead(`${accountId}:${detailKey.kind}:${detailKey.id}`, load);
  return <Stack spacing={2}>
    <Link href={routes.transfers}>Back to transfer history</Link>
    <Typography variant="h5">Saved transfer</Typography>
    <Typography color="text.secondary">Recorded identity and transaction evidence. Reading this page does not send a transfer or check the chain.</Typography>
    <TransferValue label={detailKey.kind === 'request' ? 'Request ID' : 'Operation ID'} value={detailKey.id} copy />
    {notice && (state.status !== 'ready' || !state.value.detail) && <Alert severity={notice.severity}>{notice.message}</Alert>}
    {state.status === 'loading' && <Typography role="status">Reading saved evidence…</Typography>}
    {state.status === 'failed' && <Alert severity="warning">{state.error instanceof TransferHistoryError && state.error.reason === 'identity_conflict'
      ? 'Returned details do not match this saved transfer. Its outcome remains unresolved.'
      : 'Saved transfer evidence could not be verified. Keep the original request ID and refresh when the manager is available.'}</Alert>}
    {state.status === 'ready' && <>
      {state.value.browserUnavailable && <Alert severity="info">Browser request information could not be read. The manager record is shown independently.</Alert>}
      {!state.value.detail && <Alert severity="warning">{detailKey.kind === 'request' ? 'No manager record was returned for this request.' : 'No manager record was returned for this operation.'} This does not prove that no transaction was sent.</Alert>}
      {state.value.detail ? <>
        <RecordedTransfer detail={state.value.detail} />
        <TransferRecoveryActions key={state.value.detail.operation.revision} detail={state.value.detail} accountId={accountId} notice={notice}
          finished={value => { setNotice(value); refresh(); }} />
      </> : state.value.intent && <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6">Saved browser request</Typography>
          <TransferValue label="Transfer" value={transferAmount(state.value.intent)} />
          <TransferValue label="Original deployment name" value={state.value.intent.profileName} />
          <TransferValue label="Deployment instance" value={state.value.intent.profileInstanceId} copy />
          <TransferValue label="Saved on this browser at" value={state.value.intent.createdAt} />
          <Typography variant="body2">Submission outcome unknown. The original request remains saved on this browser.</Typography>
        </Stack>
      </Paper>}
    </>}
    <Button onClick={refresh} disabled={state.status === 'loading'} sx={{ alignSelf: 'flex-start' }}>Refresh saved evidence</Button>
  </Stack>;
}

function RecordedTransfer({ detail }: { detail: ChequebookOperationDetail }) {
  const operation = detail.operation;
  return <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
    <Stack spacing={1.5}>
      <Typography variant="h6">{transferAmount(operation)}</Typography>
      <TransferEvidencePanel detail={detail} />
      <TransferValue label="Original deployment name" value={operation.profileName} />
      <TransferValue label="Deployment instance" value={operation.profileInstanceId ?? 'Not captured in this historical record'} copy={operation.profileInstanceId !== null} />
      <TransferValue label="Requested by" value={operation.requestedBy} />
      <TransferValue label="Created" value={operation.createdAt} />
      <TransferValue label="Request ID" value={operation.requestId} copy />
      <TransferValue label="Operation ID" value={operation.id} copy />
      <TransferValue label="Saved token contract" value={operation.tokenAddress} copy />
      <TransferValue label="Saved status" value={operation.state} />
      <TransferValue label="Last record update" value={operation.updatedAt} />
      <TransferRecordedEvidence detail={detail} />
    </Stack>
  </Paper>;
}
