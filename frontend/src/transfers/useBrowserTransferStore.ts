import { useEffect, useMemo } from 'react';
import { IndexedDbTransferIntentStore } from './transferIntentStore';

export function useBrowserTransferStore() {
  const store = useMemo(() => {
    try { return new IndexedDbTransferIntentStore(window.indexedDB); }
    catch { return null; }
  }, []);
  useEffect(() => () => {
    // A refused open is already reported by the read. There is no connection to dispose.
    void store?.close().catch(() => undefined);
  }, [store]);
  return store;
}
