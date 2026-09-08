import { useEffect, useState } from 'react';

type ReadState<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'failed'; readonly error: unknown };

/** The key includes account and route. Cleanup ignores late bodies even when the transport cannot cancel them. */
export function useTransferRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const token = `${key}:${attempt}`;
  const [saved, setSaved] = useState<{ token: string; state: ReadState<T> }>();
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setSaved({ token, state: { status: 'loading' } });
    void load(controller.signal).then(value => {
      if (live) setSaved({ token, state: { status: 'ready', value } });
    }, error => {
      if (live) setSaved({ token, state: { status: 'failed', error } });
    });
    return () => { live = false; controller.abort(); };
  }, [token, load]);
  return { state: saved?.token === token ? saved.state : { status: 'loading' } as ReadState<T>, refresh: () => setAttempt(value => value + 1) };
}
