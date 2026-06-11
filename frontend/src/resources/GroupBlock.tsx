import { useEffect, useState } from 'react';
import { Chip, IconButton, Stack, TableCell, TableRow, Tooltip, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import {
  formatBytes,
  formatCores,
  formatSharePercent,
} from '../format';
import type { LiveMetricsProps } from './ResourceMonitor';
import { ContainerRow } from './ContainerRow';
import type { Group } from './grouping';

export function GroupBlock({
  group,
  ncpu,
  memTotalBytes,
  history,
  diskByProject,
  onExpandProject,
}: {
  group: Group;
  ncpu: number;
  memTotalBytes: number;
} & LiveMetricsProps) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (open) onExpandProject?.(group.project);
  }, [open, group.project, onExpandProject]);

  const diskSize = diskByProject?.get(group.project);

  return (
    <>
      <TableRow
        hover
        sx={{ cursor: 'pointer', '& td': { borderBottom: 'none' } }}
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell colSpan={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <IconButton
              size="small"
              aria-label={`${open ? 'collapse' : 'expand'} ${group.project}`}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
            >
              {open ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
            <Typography variant="subtitle2">{group.project}</Typography>
            <Chip
              size="small"
              label={`${group.containers.length} containers`}
              variant="outlined"
            />
            {diskSize != null && (
              <Chip
                size="small"
                label={`data ${formatBytes(diskSize)}`}
                variant="outlined"
                color="info"
              />
            )}
          </Stack>
        </TableCell>
        <TableCell>
          <Tooltip title={`${formatCores(group.cpuPercent)} cores`}>
            <Typography variant="body2">
              {formatSharePercent(group.cpuPercent, ncpu * 100)}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell>
          <Tooltip title={formatBytes(group.memUsageBytes)}>
            <Typography variant="body2">
              {formatSharePercent(group.memUsageBytes, memTotalBytes)}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell colSpan={3} />
      </TableRow>
      {open &&
        group.containers.map((c) => (
          <ContainerRow
            key={c.id}
            c={c}
            ncpu={ncpu}
            memTotalBytes={memTotalBytes}
            history={history?.get(c.id)}
          />
        ))}
    </>
  );
}
