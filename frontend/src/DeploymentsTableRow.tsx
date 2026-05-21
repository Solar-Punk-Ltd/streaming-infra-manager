import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import {
  Alert,
  AlertTitle,
  Box,
  Checkbox,
  Collapse,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import { StatusChip } from './StatusChip';
import { clientUrl } from './data';
import type { Profile } from './types';

export function DeploymentsTableRow({
  profile,
  selected,
  onToggleSelect,
  indent = false,
}: {
  profile: Profile;
  selected: boolean;
  onToggleSelect: (name: string) => void;
  indent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const url = clientUrl(profile);
  const containers = profile.containers;
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
          {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', pl: indent ? 4 : undefined }}>
          {profile.name}
        </TableCell>
        <TableCell>{profile.kind}</TableCell>
        <TableCell align="right">{profile.port_slot}</TableCell>
        <TableCell>
          <StatusChip status={profile.status} />
        </TableCell>
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
            <Typography variant="body2" color="text.disabled">
              —
            </Typography>
          )}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell
          sx={{ p: 0, borderBottom: open ? undefined : 'unset' }}
          colSpan={7}
        >
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 2, px: 4, backgroundColor: 'action.hover' }}>
              {profile.last_error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  <AlertTitle>
                    Last error
                    {profile.last_error_at &&
                      ` · ${new Date(profile.last_error_at).toLocaleString()}`}
                  </AlertTitle>
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {profile.last_error}
                  </Typography>
                </Alert>
              )}
              <Typography variant="overline" color="text.secondary">
                Containers
              </Typography>
              <Table size="small" sx={{ mt: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Service</TableCell>
                    <TableCell>Ports</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {containers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={2}>
                        <Typography variant="body2" color="text.disabled">
                          No container snapshot recorded yet.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    containers.map((c) => (
                      <TableRow key={c.service}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {c.service}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {Object.entries(c.ports)
                            .map(([key, port]) => `${key}:${port}`)
                            .join('  ·  ')}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
