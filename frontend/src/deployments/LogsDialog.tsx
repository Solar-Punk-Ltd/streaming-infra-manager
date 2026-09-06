import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  type EngineName,
  getErrorMessage,
  saysContainerNotRunning,
} from '@streaming-infra-manager/common';

import { CopyButton } from '../CopyButton';
import { MONO_STACK } from '../app/theme';
import { EmptyState } from '../components/EmptyState';
import type { Profile } from '../types';
import { fetchContainerLogs, fetchEngineConfig } from './engineApi';
import { ENGINE_LABEL } from './engineText';
import { SERVICE_DESCRIPTIONS } from './shape';

const LOG_LINES = 200;

const VIEW_HEIGHT = 420;

type PaneKind = 'logs' | 'config';

/** The engine's own container when it is up, else whatever else is. */
function firstAvailable(services: string[], engine: EngineName): string {
  return services.includes(engine) ? engine : (services[0] ?? engine);
}

/** What to try next when there is nothing to show. */
function emptyHint(error: string | null): string {
  if (!error) {
    return 'The container has written nothing yet. Press Refresh in a moment.';
  }
  return saysContainerNotRunning(error)
    ? 'Start the deployment, then press Refresh.'
    : 'Press Refresh to try again.';
}

/**
 * The container's last lines, and the config the engine generated when it
 * started.
 *
 * One dialog for both because they answer the same question from two sides: the
 * logs say what happened, the config says what it was asked to do. The service
 * switch covers the whole deployment, so a stream that is not reaching Swarm can
 * be read from the engine and the uploader without closing anything.
 */
export function LogsDialog({
  profile,
  engine,
  onClose,
}: {
  profile: Profile;
  engine: EngineName;
  onClose: () => void;
}) {
  const services = profile.containers.map((container) => container.service);
  const [pane, setPane] = useState<PaneKind>('logs');
  const [picked, setPicked] = useState(() => firstAvailable(services, engine));
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  // Derived rather than stored, so the select's value can never be a container
  // the deployment has stopped running. A pick that comes back is used again.
  const service = services.includes(picked)
    ? picked
    : firstAvailable(services, engine);

  // The guard is what makes the last read the one on screen: a switch of pane
  // or container while a slow one is still out flips it, and that answer is
  // dropped instead of overwriting the newer one or landing after the close.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);

    const reading =
      pane === 'config'
        ? fetchEngineConfig(profile.name)
        : fetchContainerLogs(profile.name, service, LOG_LINES);

    reading
      .then((loaded) => {
        if (current) setText(loaded);
      })
      .catch((caught) => {
        if (!current) return;
        setText(null);
        setError(
          getErrorMessage(caught, 'could not read it from the container'),
        );
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [pane, profile.name, service, refreshes]);

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle
        component="div"
        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
      >
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          {profile.name}
        </Typography>
        <IconButton onClick={onClose} aria-label="close" size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Tabs
        value={pane}
        onChange={(_event, next: PaneKind) => setPane(next)}
        sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="logs" label="Logs" />
        <Tab value="config" label="Effective config" />
      </Tabs>

      <DialogContent>
        <Stack spacing={1.5}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
          >
            {pane === 'logs' ? (
              <>
                <TextField
                  select
                  size="small"
                  label="Container"
                  value={service}
                  onChange={(event) => setPicked(event.target.value)}
                  sx={{ minWidth: 220 }}
                  disabled={services.length === 0}
                >
                  {services.map((name) => (
                    <MenuItem key={name} value={name}>
                      {name} · {SERVICE_DESCRIPTIONS[name] ?? 'part of this stack'}
                    </MenuItem>
                  ))}
                </TextField>
                <Typography variant="caption" color="text.secondary">
                  Last {LOG_LINES} lines
                </Typography>
              </>
            ) : (
              <Typography variant="caption" color="text.secondary">
                The config {ENGINE_LABEL[engine]} generated when it started. This
                is what actually applied.
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            {text && <CopyButton value={text} label={pane === 'config' ? 'config' : 'logs'} />}
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              disabled={loading}
              onClick={() => setRefreshes((count) => count + 1)}
            >
              Refresh
            </Button>
          </Stack>

          {error && <Alert severity="warning">{error}</Alert>}

          <Box
            sx={{
              height: VIEW_HEIGHT,
              overflow: 'auto',
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'action.hover',
            }}
          >
            {loading && text === null ? (
              <Stack alignItems="center" sx={{ py: 8 }}>
                <CircularProgress />
              </Stack>
            ) : text ? (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.5,
                  fontFamily: MONO_STACK,
                  fontSize: '0.75rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre',
                }}
              >
                {text}
              </Box>
            ) : (
              <EmptyState title="Nothing to show." hint={emptyHint(error)} />
            )}
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
