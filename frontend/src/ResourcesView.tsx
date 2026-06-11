import { useCallback, useRef, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

import { ResourceMonitor } from './resources/ResourceMonitor';
import { useMetrics } from './useMetrics';

/**
 * Live Resources view: subscribes to the metrics SSE stream (mounted only
 * while the Resources tab is active, so the backend stops sampling when the
 * user navigates away) and lazily loads each profile's disk footprint.
 */
export function ResourcesView() {
  const { snapshot, history, connected, fetchProfileDiskBytes } = useMetrics();
  const [diskByProject, setDiskByProject] = useState<
    Map<string, number | null>
  >(new Map());
  const requested = useRef<Set<string>>(new Set());

  const onExpandProject = useCallback(
    (project: string) => {
      if (requested.current.has(project)) return;
      requested.current.add(project);
      void fetchProfileDiskBytes(project).then((size) =>
        setDiskByProject((prev) => new Map(prev).set(project, size)),
      );
    },
    [fetchProfileDiskBytes],
  );

  if (!snapshot) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ p: 6 }}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          {connected
            ? 'Waiting for first sample…'
            : 'Connecting to metrics stream…'}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box>
      <ResourceMonitor
        snapshot={snapshot}
        history={history}
        diskByProject={diskByProject}
        onExpandProject={onExpandProject}
      />
    </Box>
  );
}
