import { useMemo } from 'react';
import {
  Checkbox,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';

import { DeploymentsTableRow } from './DeploymentsTableRow';
import type { Profile } from './types';

export function DeploymentsTable({
  profiles,
  selected,
  onSelectedChange,
}: {
  profiles: Profile[];
  selected: string[];
  onSelectedChange: (names: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleOne = (name: string) => {
    const next = new Set(selectedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onSelectedChange(profiles.map((p) => p.name).filter((n) => next.has(n)));
  };

  const allChecked =
    profiles.length > 0 && profiles.every((p) => selectedSet.has(p.name));
  const someChecked =
    profiles.some((p) => selectedSet.has(p.name)) && !allChecked;

  const toggleAll = () => {
    onSelectedChange(allChecked ? [] : profiles.map((p) => p.name));
  };

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox">
              <Checkbox
                size="small"
                checked={allChecked}
                indeterminate={someChecked}
                onChange={toggleAll}
                inputProps={{ 'aria-label': 'select all deployments' }}
              />
            </TableCell>
            <TableCell />
            <TableCell>Name</TableCell>
            <TableCell>Kind</TableCell>
            <TableCell align="right">Slot</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Client URL</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {profiles.map((p) => (
            <DeploymentsTableRow
              key={p.name}
              profile={p}
              selected={selectedSet.has(p.name)}
              onToggleSelect={toggleOne}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
