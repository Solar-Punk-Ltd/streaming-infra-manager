import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import StopIcon from '@mui/icons-material/Stop';
import DeleteIcon from '@mui/icons-material/Delete';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { DeploymentsTable } from './DeploymentsTable';
import { NewDeploymentDrawer } from './NewDeploymentDrawer';
import { ResourcesView } from './ResourcesView';
import { UploadersView } from './uploaders/UploadersView';
import { ServerHostProvider } from './ServerHostContext';
import {
  canDeployUploader,
  deleteProfile,
  deployProfile,
  deployUploader,
  fetchGroups,
  fetchProfiles,
  fetchServerConfig,
  stopProfile,
} from './data';
import type { DeploymentGroup, Profile } from './types';

type AppView = 'deployments' | 'resources' | 'uploaders';

const APP_TABS: { value: AppView; label: string }[] = [
  { value: 'deployments', label: 'Deployments' },
  { value: 'resources', label: 'Resources' },
  { value: 'uploaders', label: 'Uploaders' },
];

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [groups, setGroups] = useState<DeploymentGroup[]>([]);
  const [serverHost, setServerHost] = useState<string>(
    window.location.hostname,
  );
  const [srtPassphrase, setSrtPassphrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    severity: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [view, setView] = useState<AppView>('deployments');

  const load = useCallback(() => {
    fetchProfiles()
      .then((ps) => {
        setProfiles(ps);
        setSelected((prev) => prev.filter((n) => ps.some((p) => p.name === n)));
      })
      .catch((e: Error) => setError(e.message));
    fetchGroups()
      .then(setGroups)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetchServerConfig()
      .then((cfg) => {
        setServerHost(cfg.host);
        setSrtPassphrase(cfg.srtPassphrase);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const source = new EventSource('/events');
    source.addEventListener('profile.changed', (ev: MessageEvent<string>) => {
      const { profile } = JSON.parse(ev.data) as { profile: Profile };
      setProfiles((prev) => {
        if (!prev) {
          return [profile];
        }

        const idx = prev.findIndex((p) => p.name === profile.name);

        if (idx === -1) {
          return [profile, ...prev];
        }

        const copy = prev.slice();
        copy[idx] = profile;

        return copy;
      });
    });
    source.addEventListener('profile.deleted', (ev: MessageEvent<string>) => {
      const { name } = JSON.parse(ev.data) as { name: string };
      setProfiles((prev) =>
        prev ? prev.filter((p) => p.name !== name) : prev,
      );
      setSelected((prev) => prev.filter((n) => n !== name));
    });
    return () => source.close();
  }, []);

  const handleCreated = (profiles: Profile[]) => {
    profiles.forEach((profile) => {
      setProfiles((prev) =>
        prev
          ? [profile, ...prev.filter((p) => p.name !== profile.name)]
          : [profile],
      );
    });
    load();
  };

  const nothingSelected = selected.length === 0 || busy;
  const oneSelected = selected.length === 1 && !busy;
  const selectedOne =
    profiles && selected.length === 1
      ? (profiles.find((p) => p.name === selected[0]) ?? null)
      : null;
  const uploaderDeployable =
    !busy && !!selectedOne && canDeployUploader(selectedOne);

  const runOnSelected = async (
    verb: string,
    fn: (name: string) => Promise<void>,
  ) => {
    setBusy(true);
    const names = [...selected];
    const results = await Promise.allSettled(names.map((n) => fn(n)));
    const failed = results
      .map((r, i) => ({ r, name: names[i] }))
      .filter(({ r }) => r.status === 'rejected');
    if (failed.length === 0) {
      setToast({
        severity: 'success',
        message: `${verb} ${names.length} ${names.length === 1 ? 'deployment' : 'deployments'}`,
      });
    } else {
      const first = failed[0].r as PromiseRejectedResult;
      setToast({
        severity: 'error',
        message: `${verb} failed for ${failed.map((f) => f.name).join(', ')}: ${getErrorMessage(first.reason)}`,
      });
    }
    setBusy(false);
  };

  const handleStart = () => {
    void runOnSelected('Started', deployProfile);
  };

  const handleModify = () => {
    if (selected.length !== 1 || !profiles) return;

    const target = profiles.find((p) => p.name === selected[0]);
    if (!target) return;

    setSelectedProfile(target);
    setDrawerOpen(true);
  };

  const handleStop = () => {
    void runOnSelected('Stopped', stopProfile);
  };

  const handleDeployUploader = () => {
    void runOnSelected('Deployed uploader for', deployUploader);
  };

  const handleRemove = () => {
    if (selected.length === 0) return;
    setRemoveConfirmOpen(true);
  };

  const confirmRemove = async () => {
    setRemoveConfirmOpen(false);
    await runOnSelected('Removed', deleteProfile);
  };

  return (
    <ServerHostProvider value={serverHost}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Streaming Infra — Deployments
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setSelectedProfile(null);
              setDrawerOpen(true);
            }}
          >
            New deployment
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Tabs
          value={view}
          onChange={(_e, v) => setView(v as AppView)}
          sx={{ mb: 2 }}
        >
          {APP_TABS.map((tab) => (
            <Tab key={tab.value} value={tab.value} label={tab.label} />
          ))}
        </Tabs>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {view === 'deployments' && (
          <>
            <Stack
              direction="row"
              spacing={1}
              sx={{ mb: 2 }}
              alignItems="center"
            >
              <Button
                size="small"
                variant="outlined"
                startIcon={<PlayArrowIcon />}
                disabled={nothingSelected}
                onClick={handleStart}
              >
                Start
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<EditIcon />}
                disabled={!oneSelected}
                onClick={handleModify}
              >
                Modify
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CloudUploadIcon />}
                disabled={!uploaderDeployable}
                onClick={handleDeployUploader}
              >
                Deploy uploader
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<StopIcon />}
                disabled={nothingSelected}
                onClick={handleStop}
              >
                Stop
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<DeleteIcon />}
                disabled={nothingSelected}
                onClick={handleRemove}
              >
                Remove
              </Button>
              <Box sx={{ flexGrow: 1 }} />
              <Typography variant="body2" color="text.secondary">
                {selected.length} selected
              </Typography>
            </Stack>

            {!profiles ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
                <CircularProgress />
              </Box>
            ) : (
              <DeploymentsTable
                profiles={profiles}
                groups={groups}
                selected={selected}
                onSelectedChange={setSelected}
              />
            )}
          </>
        )}

        {view === 'resources' && <ResourcesView />}

        {view === 'uploaders' && (
          <UploadersView
            profiles={profiles}
            onChanged={load}
            srtPassphrase={srtPassphrase}
          />
        )}
      </Container>

      <Dialog
        open={removeConfirmOpen}
        onClose={() => setRemoveConfirmOpen(false)}
        aria-labelledby="remove-confirm-title"
      >
        <DialogTitle id="remove-confirm-title">
          Remove{' '}
          {selected.length === 1
            ? 'deployment'
            : `${selected.length} deployments`}
          ?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This stops the containers, deletes the profile record, and{' '}
            <strong>wipes the deployment's data directory</strong> on the host.
            This action cannot be undone.
          </DialogContentText>
          <Box sx={{ mt: 2, fontFamily: 'monospace', fontSize: 13 }}>
            {selected.join(', ')}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveConfirmOpen(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={confirmRemove}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {toast ? (
          <Alert
            severity={toast.severity}
            variant="filled"
            onClose={() => setToast(null)}
            sx={{ maxWidth: 480 }}
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>

      <NewDeploymentDrawer
        open={drawerOpen}
        selectedProfile={selectedProfile}
        onClose={() => {
          setDrawerOpen(false);
          setSelectedProfile(null);
        }}
        onCreated={(profiles) => {
          handleCreated(profiles);
        }}
      />
    </ServerHostProvider>
  );
}
