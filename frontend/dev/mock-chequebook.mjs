import { randomBytes, randomUUID } from 'node:crypto';
import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE, chequebookAssertionConfirmation } from '@streaming-infra-manager/common';
import { readBody, send } from './mock-http.mjs';
import { mockChequebookRecoveryRoutes } from './mock-chequebook-recovery.mjs';
import { openReceiptPollBudget } from './mock-receipt-polling.mjs';
import { mockChequebookHistory } from './mock-chequebook-history.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['submitting', 'submitted', 'unknown']);
const hash = () => `0x${randomBytes(32).toString('hex')}`;
const inputKeys = new Set(['requestId', 'profileInstanceId', 'expectedAccountId', 'amount']);
const validInput = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => inputKeys.has(key)) &&
  typeof value.requestId === 'string' && UUID.test(value.requestId) && typeof value.profileInstanceId === 'string' && UUID.test(value.profileInstanceId) &&
  Number.isSafeInteger(value.expectedAccountId) && value.expectedAccountId > 0 && typeof value.amount === 'string' && /^[1-9][0-9]{0,29}$/.test(value.amount);

/** Synthetic records survive browser navigation. They are not a replacement for the production PostgreSQL journal. */
export function createMockChequebookJournal({ profileFor, nodeFor, userFor, onSubmitted = () => {}, responseFor = hash, receiptFor, recoveryFor }) {
  const records = new Map();
  const byRequest = new Map();
  function detail(id) {
    const record = records.get(id);
    return record ? structuredClone({ ...record, assertionConfirmation: chequebookAssertionConfirmation(record.operation.amountPlur) }) : null;
  }
  function changed(operation) {
    operation.revision = String(BigInt(operation.revision) + 1n);
    operation.updatedAt = new Date().toISOString();
  }
  function observeResponse(id, transactionHash) {
    const record = records.get(id);
    if (!record || !/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new Error('Invalid synthetic transaction response');
    const operation = record.operation;
    const conflicting = operation.failureReason === 'hash_conflict' || (operation.transactionHash !== null && operation.transactionHash !== transactionHash);
    if (!record.responseEvidence.some(evidence => evidence.transactionHash === transactionHash)) {
      record.responseEvidence.push({ transactionHash, receivedAt: new Date().toISOString(), ownership: conflicting ? 'conflict' : 'owned' });
    }
    if (conflicting) {
      operation.failureReason = 'hash_conflict';
      operation.receiptObservation = { kind: 'could_not_check', reason: 'attribution_conflict' };
      operation.receiptCheckedAt = new Date().toISOString();
      operation.recoveryObservation = { kind: 'could_not_check', reason: 'attribution_conflict', candidateHashes: record.responseEvidence.map(item => item.transactionHash) };
      operation.recoveryCheckedAt = operation.receiptCheckedAt;
    } else {
      operation.transactionHash = transactionHash;
      if (ACTIVE.has(operation.state)) operation.state = 'submitted';
      openReceiptPollBudget(operation);
    }
    changed(operation);
  }
  function observeReceipt(id, observation) {
    const operation = records.get(id)?.operation;
    if (!operation) throw new Error('Unknown synthetic operation');
    if (operation.state !== 'submitted' || operation.failureReason === 'hash_conflict') return;
    operation.receiptObservation = structuredClone(observation);
    operation.receiptCheckedAt = new Date().toISOString();
    if (observation.kind === 'settled' || observation.kind === 'reverted') operation.state = observation.kind;
    changed(operation);
  }
  function answer(res, kind, id) { send(res, kind === 'busy' || kind === 'conflict' ? 409 : 202, { ...detail(id), kind }); }

  async function submit(req, res, name, direction) {
    const input = await readBody(req);
    if (!validInput(input)) return send(res, 400, { error: 'validation_error', errors: ['A valid saved transfer request is required.'] });
    const user = userFor(req);
    if (!user) return send(res, 401, { error: 'not_signed_in' });
    if (user.id !== input.expectedAccountId) return send(res, 409, { error: 'account_changed', message: CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE });
    const requestId = input.requestId.toLowerCase();
    const previous = byRequest.get(requestId);
    if (previous) {
      const operation = records.get(previous).operation;
      const same = operation.profileName === name && operation.profileInstanceId === input.profileInstanceId.toLowerCase() &&
        operation.requestedBy === `user:${user.id}` && operation.direction === direction && operation.amountPlur === input.amount;
      return answer(res, same ? 'replayed' : 'conflict', previous);
    }
    const profile = profileFor(name);
    if (!profile || profile.instance_id !== input.profileInstanceId.toLowerCase()) return send(res, 409, { error: 'chequebook_profile_changed' });
    const node = nodeFor(name);
    if (!node) return send(res, 503, { error: 'chequebook_preparation_unavailable' });
    const blocking = [...records.values()].find(({ operation }) => operation.chainId === 100 && operation.nodeAddress === node.ethereum.toLowerCase() &&
      (ACTIVE.has(operation.state) || operation.failureReason === 'hash_conflict'));
    if (blocking) return answer(res, 'busy', blocking.operation.id);
    const now = new Date().toISOString();
    const operation = { id: randomUUID(), requestId, profileName: name, profileInstanceId: profile.instance_id, requestedBy: `user:${user.id}`,
      direction, amountPlur: input.amount, chainId: 100, nodeAddress: node.ethereum.toLowerCase(), chequebookAddress: node.chequebook.address.toLowerCase(),
      tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da', startBlockNumber: '500', startBlockHash: hash(), nonceLowerBound: '0', nonceQueryTag: '0x1f4',
      state: 'submitting', transactionHash: null, failureReason: null, dispatchStartedAt: null, revision: '0', receiptObservation: null, receiptCheckedAt: null, receiptPollUntil: null,
      recoveryObservation: null, recoveryCheckedAt: null, assertion: null, createdAt: now, updatedAt: now };
    records.set(operation.id, { operation, responseEvidence: [] });
    byRequest.set(requestId, operation.id);
    const available = BigInt(direction === 'deposit' ? node.bzz : node.chequebook.available);
    if (BigInt(node.xdai) <= 0n || BigInt(input.amount) > available) {
      operation.state = 'rejected';
      operation.failureReason = 'preflight_failed';
      changed(operation);
    } else {
      operation.dispatchStartedAt = now;
      const response = responseFor(structuredClone(operation));
      if (response === null) {
        operation.state = 'unknown';
        operation.failureReason = 'response_unavailable';
        changed(operation);
      } else observeResponse(operation.id, response);
      onSubmitted(structuredClone(operation));
    }
    answer(res, 'admitted', operation.id);
  }
  function read(req, res, id) {
    if (!userFor(req)) return send(res, 401, { error: 'not_signed_in' });
    const value = detail(id);
    send(res, value ? 200 : 404, value ?? { error: 'chequebook_operation_not_found' });
  }
  const routes = [
    ...mockChequebookRecoveryRoutes({ records, userFor, detail, changed, observeReceipt, receiptFor, recoveryFor }),
    ['POST', /^\/profiles\/([^/]+)\/chequebook\/deposit$/, (req, res, [name]) => submit(req, res, decodeURIComponent(name), 'deposit')],
    ['POST', /^\/profiles\/([^/]+)\/chequebook\/withdraw$/, (req, res, [name]) => submit(req, res, decodeURIComponent(name), 'withdraw')],
    ['GET', /^\/chequebook\/operations$/, (req, res) => {
      if (!userFor(req)) return send(res, 401, { error: 'not_signed_in' });
      try { send(res, 200, mockChequebookHistory([...records.values()].map(record => record.operation), req.url)); }
      catch { send(res, 400, { error: 'validation_error', errors: ['Invalid saved transfer history query'] }); }
    }],
    ['GET', /^\/chequebook\/operations\/by-request\/([^/]+)$/, (req, res, [id]) => read(req, res, byRequest.get(id.toLowerCase()))],
    ['GET', /^\/chequebook\/operations\/([^/]+)$/, (req, res, [id]) => read(req, res, id.toLowerCase())],
  ];
  return { routes, detail, observeReceipt, observeResponse };
}
