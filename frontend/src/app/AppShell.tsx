import { useState } from 'react';
import { Alert, Box, Drawer } from '@mui/material';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeploymentPage } from '../deployments/DeploymentPage';
import { DeploymentsPage } from '../deployments/DeploymentsPage';
import { GroupPage } from '../groups/GroupPage';
import { OverviewPage } from '../overview/OverviewPage';
import { HostPage } from '../resources/HostPage';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useActions } from './useDeploymentActions';
import { useDeployments } from './useDeploymentsStore';
import { useRoute, type Route } from './router';

const SIDEBAR_WIDTH = 232;

const PAGE_TITLES: Record<Route['page'], string> = {
  overview: 'Overview',
  deployments: 'Deployments',
  deployment: 'Deployments',
  group: 'Deployments',
  host: 'Host',
};

export function AppShell() {
  const route = useRoute();
  const { profiles, serverHost, connected, loadError } = useDeployments();
  const actions = useActions();
  const [search, setSearch] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const sidebar = (
    <Sidebar
      route={route}
      deploymentCount={profiles?.length ?? null}
      serverHost={serverHost}
      onNavigate={() => setNavOpen(false)}
    />
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: SIDEBAR_WIDTH,
          flex: 'none',
          '& .MuiDrawer-paper': {
            width: SIDEBAR_WIDTH,
            boxSizing: 'border-box',
            borderRight: 1,
            borderColor: 'divider',
          },
        }}
      >
        {sidebar}
      </Drawer>
      <Drawer
        variant="temporary"
        open={navOpen}
        onClose={() => setNavOpen(false)}
        sx={{
          display: { md: 'none' },
          '& .MuiDrawer-paper': { width: SIDEBAR_WIDTH },
        }}
      >
        {sidebar}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
        <TopBar
          title={PAGE_TITLES[route.page]}
          showSearch={route.page === 'deployments'}
          search={search}
          onSearchChange={setSearch}
          connected={connected}
          onOpenNav={() => setNavOpen(true)}
        />
        <Box sx={{ px: { xs: 2, md: 3.5 }, pt: 2, pb: 8, maxWidth: 1240 }}>
          {loadError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Could not read the deployments from the manager. {loadError}
            </Alert>
          )}
          <Page route={route} search={search} />
        </Box>
      </Box>

      <ConfirmDialog request={actions.confirm} onClose={actions.closeConfirm} />
    </Box>
  );
}

function Page({ route, search }: { route: Route; search: string }) {
  switch (route.page) {
    case 'deployments':
      return <DeploymentsPage search={search} />;
    case 'deployment':
      return <DeploymentPage name={route.name} focus={route.focus} />;
    case 'group':
      return <GroupPage id={route.id} />;
    case 'host':
      return <HostPage />;
    case 'overview':
      return <OverviewPage />;
  }
}
