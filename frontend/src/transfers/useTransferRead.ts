import { useEffect, useState } from 'react';

type ReadState<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'failed'; readonly error: unknown };

/** Asks for another read of the same key on a cadence, for as long as the last value still warrants one. */
export interface RepeatedRead<T> {
  readonly intervalMs: number;
  readonly whileReading: (value: T) => boolean;
}

type Attempt = { readonly count: number; readonly keepsValue: boolean };

/** The key includes account and route. Cleanup ignores late bodies even when the transport cannot cancel them. */
export function useTransferRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, repeat?: RepeatedRead<T>) {
  const [attempt, setAttempt] = useState<Attempt>({ count: 0, keepsValue: false });
  const token = `${key}:${attempt.count}`;
  const [saved, setSaved] = useState<{ token: string; state: ReadState<T> }>();
  const repeatIntervalMs = repeat?.intervalMs;
  const whileReading = repeat?.whileReading;
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setSaved(previous => ({ token, state: attempt.keepsValue && previous?.state.status === 'ready' ? previous.state : { status: 'loading' } }));
    let timeout: ReturnType<typeof setTimeout>;
    let again: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('Saved transfer read timed out')); }, 15_000);
    });
    void Promise.race([load(controller.signal), deadline]).then(value => {
      if (!live) return;
      setSaved({ token, state: { status: 'ready', value } });
      if (repeatIntervalMs !== undefined && whileReading?.(value)) {
        again = setTimeout(() => setAttempt(previous => ({ count: previous.count + 1, keepsValue: true })), repeatIntervalMs);
      }
    }, error => {
      if (live) setSaved({ token, state: { status: 'failed', error } });
    }).finally(() => clearTimeout(timeout));
    return () => { live = false; controller.abort(); clearTimeout(timeout); clearTimeout(again); };
  }, [token, load, attempt.keepsValue, repeatIntervalMs, whileReading]);
  return { state: saved?.token === token ? saved.state : { status: 'loading' } as ReadState<T>, refresh: () => setAttempt(previous => ({ count: previous.count + 1, keepsValue: false })) };
}
