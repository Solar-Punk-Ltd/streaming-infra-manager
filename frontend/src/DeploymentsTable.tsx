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
import { useMemo } from 'react';

import { DeploymentsTableGroupRow } from './DeploymentsTableGroupRow';
import { DeploymentsTableRow } from './DeploymentsTableRow';
import type { DeploymentGroup, Profile } from './types';

export function DeploymentsTable({
  profiles,
  groups,
  selected,
  onSelectedChange,
}: {
  profiles: Profile[];
  groups: DeploymentGroup[];
  selected: string[];
  onSelectedChange: (names: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const { ungrouped, grouped } = useMemo(() => {
    const groupsById = new Map(groups.map((g) => [g.id, g] as const));
    const byGroup = new Map<number, Profile[]>();
    const flat: Profile[] = [];
    for (const p of profiles) {
      if (p.group_id != null && groupsById.has(p.group_id)) {
        const arr = byGroup.get(p.group_id) ?? [];
        arr.push(p);
        byGroup.set(p.group_id, arr);
      } else {
        flat.push(p);
      }
    }
    const groupedList: { group: DeploymentGroup; members: Profile[] }[] = [];
    for (const g of groups) {
      const members = byGroup.get(g.id);
      if (members && members.length > 0) {
        members.sort((a, b) => a.port_slot - b.port_slot);
        groupedList.push({ group: g, members });
      }
    }
    return { ungrouped: flat, grouped: groupedList };
  }, [profiles, groups]);

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
          {grouped.map(({ group, members }) => (
            <DeploymentsTableGroupRow
              key={`group-${group.id}`}
              group={group}
              members={members}
              selectedSet={selectedSet}
              onSelectedChange={onSelectedChange}
            />
          ))}
          {ungrouped.map((p) => (
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
