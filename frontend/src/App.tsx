import { AppShell } from './app/AppShell';
import { ToastProvider } from './app/ToastProvider';
import {
  ActionsProvider,
  useDeploymentActions,
} from './app/useDeploymentActions';
import {
  DeploymentsProvider,
  useDeploymentsStore,
} from './app/useDeploymentsStore';
import { SessionProvider, useSessionStore } from './app/useSession';
import { CheckingSession, SignInPage } from './auth/SignInPage';
import { EditorsHost } from './forms/EditorsHost';
import { ServerHostProvider } from './ServerHostContext';

export function App() {
  return (
    <ToastProvider>
      <WithSession />
    </ToastProvider>
  );
}

// The shell is only mounted once there is a session, so nothing behind the gate
// opens a request or an event stream that the manager would only refuse.
function WithSession() {
  const session = useSessionStore();

  return (
    <SessionProvider value={session}>
      {session.state.status === 'loading' && <CheckingSession />}
      {session.state.status === 'signedOut' && <SignInPage />}
      {session.state.status === 'signedIn' && <WithDeployments />}
    </SessionProvider>
  );
}

// Split so each provider can use the one above it: the actions hook toasts and
// reads the store, and the store's host is what every URL is built from.
function WithDeployments() {
  const store = useDeploymentsStore();

  return (
    <DeploymentsProvider value={store}>
      <ServerHostProvider value={store.serverHost}>
        <WithActions />
      </ServerHostProvider>
    </DeploymentsProvider>
  );
}

function WithActions() {
  const actions = useDeploymentActions();

  return (
    <ActionsProvider value={actions}>
      <EditorsHost>
        <AppShell />
      </EditorsHost>
    </ActionsProvider>
  );
}
