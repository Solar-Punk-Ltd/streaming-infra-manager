import { Divider, Stack, Typography } from '@mui/material';
import { type ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { TransferValue } from './TransferEvidencePanel';
import { hasRecordedTransferAssertion } from './transferEvidence';

const reasons: Record<string, string> = {
  rpc_unavailable: 'The chain service could not be reached', identity_mismatch: 'The transaction did not match the saved identity',
  chain_changed: 'The recorded chain history changed', history_incomplete: 'The checked history is incomplete',
  attribution_conflict: 'Transaction ownership needs review', evidence_limit: 'The evidence limit was reached',
  awaiting_transaction: 'Waiting for the transaction', awaiting_receipt: 'Waiting for a receipt', awaiting_finality: 'Waiting for finality',
};
const recoveryLabels: Record<string, string> = { searching: 'Search incomplete', no_match: 'No match in the completed search',
  candidate: 'A matching candidate was recorded', ambiguous: 'Multiple matching candidates need review', could_not_check: 'Recovery could not be completed' };
const text = (value: unknown) => typeof value === 'string' ? value : 'Not recorded';

/** Shows stored observations only. None of these reads checks a transaction or changes its journal. */
export function TransferRecordedEvidence({ detail }: { detail: ChequebookOperationDetail }) {
  const operation = detail.operation;
  const receipt = operation.receiptObservation;
  const recovery = operation.recoveryObservation;
  const scan = recovery?.scan;
  const candidates = Array.isArray(recovery?.candidateHashes) ? recovery.candidateHashes.filter(value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)) : [];
  return <Stack spacing={1.25}>
    <Divider />
    <Typography variant="subtitle1">Recorded transaction evidence</Typography>
    <TransferValue label="Dispatch started at" value={operation.dispatchStartedAt ?? 'No dispatch start is recorded'} />
    <TransferValue label="Frozen starting block" value={operation.startBlockNumber} />
    <TransferValue label="Frozen starting block hash" value={operation.startBlockHash} copy />
    {receipt && <>
      <TransferValue label="Saved receipt observation" value={receipt.kind === 'settled' ? 'Successful receipt recorded' : receipt.kind === 'reverted'
        ? 'Reverted receipt recorded' : receipt.kind === 'pending' ? 'Receipt confirmation pending' : 'Receipt could not be checked'} />
      {'reason' in Object(receipt) && <TransferValue label="Receipt observation reason" value={reasons[(receipt as { reason: string }).reason] ?? 'The saved reason could not be verified'} />}
      {(receipt.kind === 'settled' || receipt.kind === 'reverted') && <>
        <TransferValue label="Receipt block" value={text(receipt.receiptBlockNumber)} />
        <TransferValue label="Receipt block hash" value={text(receipt.receiptBlockHash)} copy />
        <TransferValue label="Checked finalized block" value={text(receipt.finalizedBlockNumber)} />
        <TransferValue label="Checked finalized block hash" value={text(receipt.finalizedBlockHash)} copy />
      </>}
    </>}
    {recovery && <>
      <TransferValue label="Saved recovery observation" value={recoveryLabels[recovery.kind] ?? 'The saved observation could not be verified'} />
      {recovery.kind === 'could_not_check' && <TransferValue label="Recovery observation reason" value={reasons[recovery.reason] ?? 'The saved reason could not be verified'} />}
      {recovery.kind === 'no_match' && <Typography variant="body2">A completed search covers only its recorded range and observations. It cannot prove that no transaction will appear later.</Typography>}
      {candidates.map(hash => <TransferValue key={hash} label="Retained candidate hash" value={hash} copy />)}
      {scan && <>
        <TransferValue label="Search head block" value={text(scan.headBlockNumber)} />
        <TransferValue label="Search head block hash" value={text(scan.headBlockHash)} copy />
        <TransferValue label="Search cursor block" value={text(scan.nextBlockNumber)} />
        <TransferValue label="Search cursor block hash" value={text(scan.nextBlockHash)} copy />
        <TransferValue label="Search progress" value={scan.complete === true ? 'Recorded pass complete' : 'Recorded pass incomplete'} />
      </>}
      {recovery.kind === 'could_not_check' && recovery.reason === 'attribution_conflict' && recovery.additionalEvidenceInResponseJournal &&
        <Typography variant="body2">Additional transaction evidence appears below. The retained candidate list is not exhaustive.</Typography>}
    </>}
    <Typography variant="subtitle2">Submission response evidence</Typography>
    {detail.responseEvidence.length === 0 && <Typography variant="body2">No direct response evidence is recorded.</Typography>}
    {detail.responseEvidence.map((evidence, index) => <Stack key={`${evidence.transactionHash}:${index}`} spacing={0.5}>
      <TransferValue label="Response transaction hash" value={evidence.transactionHash} copy />
      <TransferValue label="Response received at" value={evidence.receivedAt} />
      <TransferValue label="Recorded attribution" value={evidence.ownership === 'conflict' ? 'Conflicting transaction ownership' : 'Assigned to this operation'} />
    </Stack>)}
    {hasRecordedTransferAssertion(detail) && operation.assertion && <>
      <Typography variant="subtitle2">Operator assertion</Typography>
      <Typography variant="body2">This records the operator’s acceptance of duplicate-payment risk. It does not prove that no transaction was sent.</Typography>
      <TransferValue label="Asserted by" value={operation.assertion.actor} />
      <TransferValue label="Asserted at" value={operation.assertion.assertedAt} />
      <TransferValue label="Recorded confirmation" value={operation.assertion.confirmation} />
    </>}
  </Stack>;
}
