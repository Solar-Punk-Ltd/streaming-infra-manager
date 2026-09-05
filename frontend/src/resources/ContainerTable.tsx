import { useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@mui/material';

import type { MetricsSnapshot } from '../types';
import { GroupBlock } from './GroupBlock';
import { groupByProject } from './grouping';
import type { LiveMetricsProps } from './liveMetrics';

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
    <Table>
      <TableHead>
        <TableRow>
          <TableCell>Deployment / service</TableCell>
          <TableCell>State</TableCell>
          <TableCell>CPU</TableCell>
          <TableCell>Memory</TableCell>
          <TableCell align="right">Network</TableCell>
          <TableCell align="right">Disk I/O</TableCell>
          <TableCell align="right">PIDs</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {groups.map((group) => (
          <GroupBlock
            key={group.project}
            group={group}
            ncpu={snapshot.host.ncpu}
            memTotalBytes={snapshot.host.memTotalBytes}
            history={history}
            diskByProject={diskByProject}
            onExpandProject={onExpandProject}
          />
        ))}
      </TableBody>
    </Table>
  );
}
