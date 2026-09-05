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
import { EditorsHost } from './forms/EditorsHost';
import { ServerHostProvider } from './ServerHostContext';

export function App() {
  return (
    <ToastProvider>
      <WithDeployments />
    </ToastProvider>
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
