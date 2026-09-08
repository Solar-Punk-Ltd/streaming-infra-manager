import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { SessionInfo } from '@streaming-infra-manager/common';

import {
  probeSession,
  signIn as requestSignIn,
  signOut as requestSignOut,
  type SignedOutReason,
  type SignInResult,
} from '../auth/authApi';
import { SessionEndedError, setSessionEndedHandler } from '../http';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut'; reason: SignedOutReason }
  | ({ status: 'signedIn' } & SessionInfo);

export interface SessionStore {
  state: SessionState;
  signIn: (username: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionStore | null>(null);

export const SessionProvider = SessionContext.Provider;

export function useSession(): SessionStore {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession must be used inside SessionProvider');
  }
  return session;
}

/**
 * Whether anyone is signed in, which decides what the whole app renders.
 *
 * It asks once on boot and then trusts itself, with one exception: any 401
 * from anywhere in the app calls back into here through http.ts, because a
 * session can be revoked or expire between two clicks and the screen must not
 * go on showing a shell whose every request is being refused.
 */
export function useSessionStore(): SessionStore {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const probe = await probeSession();
    setState(
      probe.signedIn
        ? { status: 'signedIn', ...probe.session }
        : { status: 'signedOut', reason: probe.reason },
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setSessionEndedHandler(() =>
      setState({ status: 'signedOut', reason: 'ended' }),
    );
    return () => setSessionEndedHandler(null);
  }, []);

  const signIn = useCallback(
    async (username: string, password: string): Promise<SignInResult> => {
      const result = await requestSignIn(username, password);
      if (result.ok) await refresh();
      return result;
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await requestSignOut();
    } catch (error) {
      // A session that had already gone is a sign-out that has already
      // happened. Anything else leaves the session standing on the manager,
      // so the caller is told rather than shown a sign-in page that lies.
      if (!(error instanceof SessionEndedError)) throw error;
      // The fetch wrapper has already set the reason to "ended", which is the
      // one the sign-in page has something to say about. Falling through would
      // overwrite it with the blank one.
      return;
    }
    setState({ status: 'signedOut', reason: 'notSignedIn' });
  }, []);

  return { state, signIn, signOut };
}
