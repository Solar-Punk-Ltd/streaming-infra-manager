import { useLayoutEffect, useRef, useState } from 'react';
import type { ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { SessionEndedError } from '../http';
import { readTransferDetail, transferIdentity, TransferHistoryError } from './transferHistoryApi';
import { runTransferRecovery, TransferRecoveryError, type TransferRecoveryAction } from './transferRecoveryApi';
import { canAssertTransfer, canCheckTransfer } from './transferRecoveryEligibility';

export interface RecoveryNotice { readonly severity: 'info' | 'warning'; readonly message: string }
interface Work { readonly key: string; readonly controller: AbortController; sent: boolean }
interface AssertionDraft { readonly key: string; readonly detail: ChequebookOperationDetail; readonly stage: 'typing' | 'confirming'; readonly text: string }

async function bounded<T>(work: Work, timeout: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = work.controller.signal;
  if (signal.aborted) throw new Error('Recovery request ended');
  let stop: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('Recovery request ended'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  const timer = setTimeout(() => work.controller.abort(), timeout);
  try { return await Promise.race([cancelled, run(signal)]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}

/** Every action is explicitly requested and rechecks its captured evidence before its single POST. */
export function useTransferRecovery(detail: ChequebookOperationDetail, accountId: number, finished: (notice: RecoveryNotice) => void) {
  const key = `${accountId}:${transferIdentity(detail.operation)}:${detail.operation.revision}`;
  const context = useRef(key);
  context.current = key;
  const mounted = useRef(false);
  const active = useRef<Work | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AssertionDraft | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    setBusy(false);
    setDraft(null);
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null; };
  }, [key]);
  const current = (work: Work) => mounted.current && active.current === work && context.current === work.key;
  function start(): Work | null {
    if (!mounted.current || active.current) return null;
    const work = { key, controller: new AbortController(), sent: false };
    active.current = work;
    setBusy(true);
    return work;
  }
  function done(work: Work) {
    if (current(work)) { active.current = null; setBusy(false); }
    work.controller.abort();
  }
  function notice(work: Work, value: RecoveryNotice) {
    if (current(work)) { setDraft(null); finished(value); }
  }
  function failed(work: Work, error: unknown) {
    if (error instanceof SessionEndedError) return;
    const message = error instanceof TransferRecoveryError ? error.message : error instanceof TransferHistoryError && error.reason === 'identity_conflict'
      ? new TransferRecoveryError('identity_conflict', 'unknown').message : work.sent
        ? new TransferRecoveryError('unavailable', 'unknown').message
        : 'Fresh evidence could not be read. No recovery action was sent. Refresh saved evidence before trying again.';
    notice(work, { severity: 'warning', message });
  }
  async function fresh(work: Work, reviewed: ChequebookOperationDetail): Promise<ChequebookOperationDetail> {
    const latest = await bounded(work, 15_000, signal => readTransferDetail({ kind: 'operation', id: reviewed.operation.id }, signal));
    if (!current(work) || work.controller.signal.aborted) throw new Error('Recovery review ended');
    if (!latest) throw new TransferRecoveryError('not_found', 'refused');
    if (transferIdentity(latest.operation) !== transferIdentity(reviewed.operation)) throw new TransferRecoveryError('identity_conflict', 'refused');
    if (latest.operation.revision !== reviewed.operation.revision) throw new TransferRecoveryError('operation_changed', 'refused');
    return latest;
  }
  async function perform(action: TransferRecoveryAction, reviewed = detail) {
    const work = start();
    if (!work) return;
    try {
      const latest = await fresh(work, reviewed);
      if (!canCheckTransfer(latest) || (action.kind === 'assert' && !canAssertTransfer(latest))) throw new TransferRecoveryError('recovery_required', 'refused');
      if (!current(work) || work.controller.signal.aborted) throw new Error('Recovery review ended');
      work.sent = true;
      await bounded(work, 60_000, signal => runTransferRecovery(latest, accountId, action, signal));
      notice(work, { severity: 'info', message: 'The action response was received. The saved evidence is being refreshed.' });
    } catch (error) { failed(work, error); }
    finally { done(work); }
  }
  async function beginAssertion() {
    const work = start();
    if (!work) return;
    try {
      const latest = await fresh(work, detail);
      if (!canAssertTransfer(latest)) throw new TransferRecoveryError('recovery_required', 'refused');
      if (current(work)) setDraft({ key, detail: latest, stage: 'typing', text: '' });
    } catch (error) { failed(work, error); }
    finally { done(work); }
  }
  function confirmAssertion() {
    if (!draft || draft.key !== key || draft.stage !== 'confirming' || draft.text !== draft.detail.assertionConfirmation) return;
    void perform({ kind: 'assert', expectedRevision: draft.detail.operation.revision, amountPlur: draft.detail.operation.amountPlur,
      confirmation: draft.text }, draft.detail);
  }
  const assertion = draft?.key === key ? draft : null;
  return { busy, assertion, perform, beginAssertion, confirmAssertion,
    stopWaiting: () => active.current?.controller.abort(),
    cancelAssertion: () => setDraft(null),
    setAssertionText: (text: string) => setDraft(value => value?.key === key && value.stage === 'typing' ? { ...value, text } : value),
    reviewAssertion: () => setDraft(value => value?.key === key && value.text === value.detail.assertionConfirmation ? { ...value, stage: 'confirming' } : value),
  };
}
