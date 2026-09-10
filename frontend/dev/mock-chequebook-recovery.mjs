import { CHEQUEBOOK_OPERATION_CHANGED_MESSAGE, CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE, chequebookAssertionConfirmation, isChequebookRevision } from '@streaming-infra-manager/common';
import { readBody, send } from './mock-http.mjs';
import { openReceiptPollBudget } from './mock-receipt-polling.mjs';

const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const recoverable = operation => ['submitting', 'unknown'].includes(operation.state) && operation.failureReason !== 'hash_conflict';
const fields = { check: ['expectedAccountId'], resolve: ['expectedAccountId', 'transactionHash'], assert: ['expectedAccountId', 'expectedRevision', 'amountPlur', 'confirmation'] };
function validInput(kind, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields[kind].includes(key)) ||
      !Number.isSafeInteger(input.expectedAccountId) || input.expectedAccountId < 1) return false;
  if (kind === 'resolve') return hash(input.transactionHash);
  if (kind === 'assert') return isChequebookRevision(input.expectedRevision) && typeof input.amountPlur === 'string' && /^[1-9][0-9]{0,29}$/.test(input.amountPlur) &&
    typeof input.confirmation === 'string' && input.confirmation.length > 0 && input.confirmation.length <= 200;
  return true;
}
function retainedObservation(operation, input) {
  if (!input || !['searching', 'no_match', 'candidate', 'ambiguous', 'could_not_check'].includes(input.kind) ||
      !Array.isArray(input.candidateHashes) || !input.candidateHashes.every(hash)) throw new Error('Invalid synthetic recovery observation');
  const candidateHashes = [...new Set([...(operation.recoveryObservation?.candidateHashes ?? []), ...input.candidateHashes].map(value => value.toLowerCase()))];
  if (candidateHashes.length > 256) throw new Error('Invalid synthetic recovery evidence size');
  const previousScan = operation.recoveryObservation?.scan;
  const scan = input.kind === 'could_not_check' && input.reason === 'chain_changed' ? undefined : input.scan ?? previousScan;
  if (scan && (BigInt(scan.nextBlockNumber) < BigInt(operation.startBlockNumber) ||
      (scan.complete && (scan.nextBlockNumber !== operation.startBlockNumber || scan.nextBlockHash !== operation.startBlockHash)))) throw new Error('Invalid synthetic recovery anchor');
  const evidence = { candidateHashes, ...(scan ? { scan: { ...structuredClone(scan), candidateHashes } } : {}) };
  if (input.kind === 'no_match' && candidateHashes.length > 0) return { kind: 'could_not_check', reason: 'rpc_unavailable', ...evidence };
  if (input.kind === 'no_match' && scan?.complete !== true) throw new Error('Incomplete synthetic search cannot report no match');
  if (input.kind === 'candidate' && candidateHashes.length > 1) return { kind: 'ambiguous', ...evidence };
  if (input.kind === 'candidate' && candidateHashes.length !== 1) throw new Error('A synthetic candidate needs one verified hash');
  return { ...structuredClone(input), ...evidence };
}

/** The injected callbacks are synthetic verified observations, never chain endpoints or browser-controlled routes. */
export function mockChequebookRecoveryRoutes({ records, userFor, detail, changed, observeReceipt,
  receiptFor = async () => ({ kind: 'pending', reason: 'awaiting_receipt' }),
  recoveryFor = async () => ({ kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }) }) {
  async function receipt(operation) {
    if (operation.state !== 'submitted' || operation.failureReason === 'hash_conflict') return;
    const revision = operation.revision;
    const observation = await receiptFor(structuredClone(operation));
    if (operation.revision === revision) observeReceipt(operation.id, observation);
  }
  async function recover(operation, manualHash) {
    if (!recoverable(operation)) return;
    const revision = operation.revision;
    const observation = await recoveryFor(structuredClone(operation), manualHash);
    // The production observation CAS returns current evidence unchanged. Direct responses have a separate journal path.
    if (operation.revision !== revision || !recoverable(operation)) return;
    let recorded = retainedObservation(operation, observation);
    if (recorded.kind === 'candidate') {
      const transactionHash = recorded.candidateHashes[0];
      const competing = [...records.values()].some(({ operation: other }) => other.id !== operation.id && other.chainId === operation.chainId &&
        (other.transactionHash === transactionHash || (other.dispatchStartedAt !== null && other.nodeAddress === operation.nodeAddress &&
          other.direction === operation.direction && other.amountPlur === operation.amountPlur && other.chequebookAddress === operation.chequebookAddress &&
          (!other.transactionHash || other.failureReason === 'hash_conflict'))));
      if (competing) recorded = { ...recorded, kind: 'ambiguous' };
      else { operation.transactionHash = transactionHash; operation.state = 'submitted'; openReceiptPollBudget(operation); }
    }
    operation.recoveryObservation = recorded;
    operation.recoveryCheckedAt = new Date().toISOString();
    changed(operation);
    await receipt(operation);
  }
  async function act(req, res, id, kind) {
    const input = await readBody(req);
    if (!validInput(kind, input)) return send(res, 400, { error: 'validation_error', errors: ['A valid recovery request is required.'] });
    const user = userFor(req);
    if (!user) return send(res, 401, { error: 'not_signed_in' });
    if (user.id !== input.expectedAccountId) return send(res, 409, { error: 'account_changed', message: CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE });
    const operation = records.get(id)?.operation;
    if (!operation) return send(res, 404, { error: 'chequebook_operation_not_found' });
    if (kind === 'assert') {
      if (input.expectedRevision !== operation.revision) return send(res, 409, { error: 'operation_changed', message: CHEQUEBOOK_OPERATION_CHANGED_MESSAGE });
      if (input.amountPlur !== operation.amountPlur || input.confirmation !== chequebookAssertionConfirmation(operation.amountPlur)) {
        return send(res, 400, { error: 'validation_error', errors: ['The exact amount and confirmation are required.'] });
      }
      if (recoverable(operation)) {
        if (operation.recoveryObservation?.kind !== 'no_match') return send(res, 409, { error: 'chequebook_recovery_required' });
        operation.assertion = { actor: `user:${user.id}`, amountPlur: input.amountPlur, confirmation: input.confirmation, assertedAt: new Date().toISOString() };
        operation.state = 'asserted';
        changed(operation);
      }
    } else if (kind === 'resolve') {
      const transactionHash = input.transactionHash.toLowerCase();
      if (operation.state === 'submitted' && operation.transactionHash === transactionHash) await receipt(operation);
      else await recover(operation, transactionHash);
    } else if (operation.state === 'submitted') await receipt(operation);
    else await recover(operation);
    send(res, 200, detail(operation.id));
  }
  return ['check', 'resolve', 'assert'].map(kind => ['POST', new RegExp(`^/chequebook/operations/([0-9a-f-]+)/${kind}$`, 'i'),
    (req, res, [id]) => act(req, res, id.toLowerCase(), kind)]);
}
