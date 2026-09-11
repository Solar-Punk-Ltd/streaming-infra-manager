import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { RECEIPT_READ_INTERVAL_MS } from '@streaming-infra-manager/common';
import { TransferController } from './TransferController';
import { transferApi } from './transferApi';
import { IndexedDbTransferIntentStore } from './transferIntentStore';
import { isPollingReceipt } from './receiptPolling';

export function useTransferController(open: boolean, accountId: number | null, profileName: string, instanceId: string) {
  const [{ store, controller }] = useState(() => {
    const store = new IndexedDbTransferIntentStore({ open: (...args) => globalThis.indexedDB.open(...args) });
    return { store, controller: new TransferController(store, transferApi) };
  });
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  useLayoutEffect(() => {
    controller.setContext(accountId, { name: profileName, instanceId });
    if (open) void controller.restore();
    else controller.cancel();
    return () => controller.cancel();
  }, [controller, open, accountId, profileName, instanceId]);
  useEffect(() => {
    if (!open) return;
    const restore = () => { if (document.visibilityState === 'visible') void controller.restore(); };
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', restore);
    return () => { window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore); };
  }, [controller, open]);
  // Reading the saved record, never checking the chain: the manager is doing that until this deadline.
  const polledUntil = state.detail && isPollingReceipt(state.detail.operation) ? state.detail.operation.receiptPollUntil : null;
  useEffect(() => {
    if (!open || polledUntil === null) return;
    const timer = setInterval(() => { void controller.restore(); }, RECEIPT_READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [controller, open, polledUntil]);
  useEffect(() => () => { controller.cancel(); void store.close().catch(() => undefined); }, [controller, store]);
  return { controller, state };
}
