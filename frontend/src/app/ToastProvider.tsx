import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Snackbar } from '@mui/material';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export type ShowToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

const AUTO_HIDE_MS = 5_000;

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/**
 * One toast on screen at a time, the rest queued behind it.
 *
 * A queue rather than a stack because the fan-out actions (Start all, Remove
 * group) report once per call, and a burst of overlapping snackbars hides the
 * one that carries the failure.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Toast[]>([]);
  // The id keys the Snackbar, so two toasts must never share one: a shared id
  // would reuse the first toast's auto-hide timer for the second.
  const nextId = useRef(0);

  const show = useCallback<ShowToast>((message, tone = 'info') => {
    nextId.current += 1;
    const id = nextId.current;
    setQueue((prev) => [...prev, { id, message, tone }]);
  }, []);

  const current = queue[0] ?? null;
  const dismiss = useCallback(() => setQueue((prev) => prev.slice(1)), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <Snackbar
        key={current?.id}
        open={current !== null}
        autoHideDuration={AUTO_HIDE_MS}
        onClose={dismiss}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {current ? (
          <Alert
            severity={current.tone}
            variant="filled"
            onClose={dismiss}
            sx={{ maxWidth: 460 }}
          >
            {current.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </ToastContext.Provider>
  );
}
