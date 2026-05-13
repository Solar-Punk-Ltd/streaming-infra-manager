import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  Toolbar,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

import { DeploymentsTable } from './DeploymentsTable';
import { NewDeploymentDrawer } from './NewDeploymentDrawer';
import { fetchProfiles } from './data';
import type { Profile } from './types';

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedMock, setUsedMock] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(() => {
    fetchProfiles()
      .then(({ profiles: ps, usedMock }) => {
        setProfiles(ps);
        setUsedMock(usedMock);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = (profile: Profile) => {
    setProfiles((prev) => (prev ? [profile, ...prev.filter((p) => p.name !== profile.name)] : [profile]));
    load();
  };

  return (
    <>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Streaming Infra — Deployments
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setDrawerOpen(true)}
          >
            New deployment
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        {usedMock && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Backend at <code>/profiles</code> unreachable — showing mock data. Start the manager
            and reload to use live data.
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {!profiles ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <DeploymentsTable profiles={profiles} />
        )}
      </Container>

      <NewDeploymentDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={handleCreated}
      />
    </>
  );
}
