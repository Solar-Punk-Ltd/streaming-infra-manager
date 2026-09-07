import { checkSessionAfterStreamClosed } from './http';

/** First pause before reopening a closed stream. Doubles each time. */
const RECONNECT_BASE_MS = 1_000;
/** The pause stops growing here. A manager restart is over well within it. */
const RECONNECT_MAX_MS = 15_000;

export type LiveEventHandler = (event: MessageEvent<string>) => void;

export interface LiveStreamHandlers {
  /** The stream is open. Fires again after every reconnect. */
  onOpen: () => void;
  /** The stream is not delivering, whether the browser or this helper retries. */
  onDown: () => void;
  /** Named server-sent events and what to do with each. */
  events: Record<string, LiveEventHandler>;
}

/**
 * Keeps a server-sent event stream open for as long as the page needs it.
 *
 * The browser reconnects an `EventSource` on its own only when the failure was
 * the network. When the server answers anything but 200, which is what the
 * manager's proxy does for the seconds the manager is restarting, the browser
 * closes the source for good, and a page left like that shows "offline" until
 * someone reloads it. This reopens the stream after a pause that grows to a
 * ceiling, asking first whether the session is still there, so a session that
 * ended lands on the sign-in page instead of in a retry loop.
 *
 * Returns the function that stops it, for the effect's cleanup.
 */
export function openLiveStream(
  url: string,
  handlers: LiveStreamHandlers,
): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    const next = new EventSource(url);
    source = next;

    next.onopen = () => {
      attempt = 0;
      handlers.onOpen();
    };

    next.onerror = () => {
      handlers.onDown();
      // CONNECTING here means the browser is retrying by itself.
      if (next.readyState !== EventSource.CLOSED) return;
      next.close();
      if (source === next) source = null;
      void checkSessionAfterStreamClosed().then((signedIn) => {
        if (signedIn) scheduleReconnect();
      });
    };

    for (const [name, handler] of Object.entries(handlers.events)) {
      next.addEventListener(name, handler);
    }
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    source?.close();
  };
}
