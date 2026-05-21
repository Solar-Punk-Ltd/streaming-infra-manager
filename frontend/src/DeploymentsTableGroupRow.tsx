import {
  Box,
  Checkbox,
  Chip,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import { DeploymentsTableRow } from './DeploymentsTableRow';
import type { DeploymentGroup, Profile } from './types';

export function DeploymentsTableGroupRow({
  group,
  members,
  selectedSet,
  onSelectedChange,
}: {
  group: DeploymentGroup;
  members: Profile[];
  selectedSet: Set<string>;
  onSelectedChange: (names: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const allChecked =
    members.length > 0 && members.every((p) => selectedSet.has(p.name));
  const someChecked =
    members.some((p) => selectedSet.has(p.name)) && !allChecked;

  const toggleGroupSelect = () => {
    const next = new Set(selectedSet);
    if (allChecked) {
      members.forEach((m) => next.delete(m.name));
    } else {
      members.forEach((m) => next.add(m.name));
    }
    onSelectedChange(Array.from(next));
  };

  const toggleMember = (name: string) => {
    const next = new Set(selectedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onSelectedChange(Array.from(next));
  };

  return (
    <>
      <TableRow
        hover
        onClick={() => setOpen((o) => !o)}
        sx={{
          cursor: 'pointer',
          backgroundColor: 'action.selected',
          '& > *': { borderBottom: 'unset' },
        }}
      >
        <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            size="small"
            checked={allChecked}
            indeterminate={someChecked}
            onChange={toggleGroupSelect}
            inputProps={{ 'aria-label': `select group ${group.name}` }}
          />
        </TableCell>
        <TableCell padding="checkbox">
          {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
        </TableCell>
        <TableCell colSpan={5}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
              {group.name}
            </Typography>
            <Chip size="small" label={`group · ${members.length}`} />
            <Typography variant="caption" color="text.secondary">
              {new Date(group.created_at).toLocaleString()}
            </Typography>
          </Box>
        </TableCell>
      </TableRow>
      {open &&
        members.map((m) => (
          <DeploymentsTableRow
            key={m.name}
            profile={m}
            selected={selectedSet.has(m.name)}
            onToggleSelect={toggleMember}
            indent
          />
        ))}
    </>
  );
}
