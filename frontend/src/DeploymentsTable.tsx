import { useMemo, useState } from 'react';
import {
  Box,
  Checkbox,
  Collapse,
  IconButton,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import { StatusChip } from './StatusChip';
import { clientUrl, containersFor } from './data';
import type { Profile } from './types';

function Row({
  profile,
  selected,
  onToggleSelect,
}: {
  profile: Profile;
  selected: boolean;
  onToggleSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const url = clientUrl(profile);
  const containers = containersFor(profile);
  const toggle = () => setOpen((o) => !o);

  return (
    <>
      <TableRow
        hover
        onClick={toggle}
        sx={{ '& > *': { borderBottom: 'unset' }, cursor: 'pointer' }}
      >
        <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            size="small"
            checked={selected}
            onChange={() => onToggleSelect(profile.name)}
            inputProps={{ 'aria-label': `select ${profile.name}` }}
          />
        </TableCell>
        <TableCell padding="checkbox">
          <IconButton
            size="small"
            aria-label={open ? 'collapse' : 'expand'}
            tabIndex={-1}
          >
            {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace' }}>{profile.name}</TableCell>
        <TableCell>{profile.kind}</TableCell>
        <TableCell align="right">{profile.port_slot}</TableCell>
        <TableCell><StatusChip status={profile.status} /></TableCell>
        <TableCell>
          {url ? (
            <Link
              href={url}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
            >
              {url}
            </Link>
          ) : (
            <Typography variant="body2" color="text.disabled">—</Typography>
          )}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ p: 0, borderBottom: open ? undefined : 'unset' }} colSpan={7}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 2, px: 4, backgroundColor: 'action.hover' }}>
              <Typography variant="overline" color="text.secondary">Containers</Typography>
              <Table size="small" sx={{ mt: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Service</TableCell>
                    <TableCell>Ports</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {containers.map((c) => (
                    <TableRow key={c.service}>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{c.service}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>
                        {c.ports.map((p) => `${p.label}:${p.port}`).join('  ·  ')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

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

  const allChecked = profiles.length > 0 && profiles.every((p) => selectedSet.has(p.name));
  const someChecked = profiles.some((p) => selectedSet.has(p.name)) && !allChecked;

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
            <Row
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
