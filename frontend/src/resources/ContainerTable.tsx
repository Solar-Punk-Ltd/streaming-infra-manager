import { useMemo } from 'react';
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import type { MetricsSnapshot } from '../types';
import type { LiveMetricsProps } from './ResourceMonitor';
import { GroupBlock } from './GroupBlock';
import { groupByProject } from './grouping';

export function ContainerTable({
  snapshot,
  history,
  diskByProject,
  onExpandProject,
}: { snapshot: MetricsSnapshot } & LiveMetricsProps) {
  const groups = useMemo(
    () => groupByProject(snapshot.containers),
    [snapshot.containers],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Per container (our infra only)
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Profile / Service</TableCell>
              <TableCell>State</TableCell>
              <TableCell>CPU</TableCell>
              <TableCell>Memory</TableCell>
              <TableCell align="right">Network</TableCell>
              <TableCell align="right">Disk I/O</TableCell>
              <TableCell align="right">PIDs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {groups.map((g) => (
              <GroupBlock
                key={g.project}
                group={g}
                ncpu={snapshot.host.ncpu}
                memTotalBytes={snapshot.host.memTotalBytes}
                history={history}
                diskByProject={diskByProject}
                onExpandProject={onExpandProject}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
