import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  Alert,
  AlertTitle,
  Box,
  Checkbox,
  Collapse,
  IconButton,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import { StampRequiredChip, StatusChip } from './StatusChip';
import { useServerHost } from './ServerHostContext';
import { clientUrl, componentUrl, hostFor } from './urls';
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const serverHost = useServerHost();
  const url = clientUrl(profile, serverHost);
  const host = hostFor(profile, serverHost);
  const containers = profile.containers;
  const toggle = () => setOpen((o) => !o);

  const copyUrl = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  };

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
          <Stack direction="row" spacing={1} alignItems="center">
            <StatusChip status={profile.status} />
            {profile.pendingStamp && <StampRequiredChip />}
          </Stack>
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
              {profile.pendingStamp && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  <AlertTitle>Stamp required</AlertTitle>
                  <Typography variant="body2">
                    The <code>stream-uploader</code> is held back until a usable
                    postage stamp is provided — the rest of the stack is running.
                    Add a stamp (Modify → Stamp ID), then use{' '}
                    <strong>Deploy uploader</strong> to complete the stack.
                  </Typography>
                </Alert>
              )}
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
                          <Stack spacing={0.5}>
                            {Object.entries(c.ports).map(([key, port]) => {
                              const href = componentUrl(host, port);
                              const copyKey = `${c.service}:${key}`;
                              return (
                                <Stack
                                  key={key}
                                  direction="row"
                                  alignItems="center"
                                  spacing={1}
                                  sx={{ whiteSpace: 'nowrap' }}
                                >
                                  <Box component="span">
                                    {key}:{port}
                                  </Box>
                                  <Box sx={{ flexGrow: 1 }} />
                                  <Link
                                    href={href}
                                    target="_blank"
                                    rel="noopener"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {href}
                                  </Link>
                                  <Tooltip
                                    title={
                                      copiedKey === copyKey ? 'Copied' : 'Copy URL'
                                    }
                                  >
                                    <IconButton
                                      size="small"
                                      aria-label={`copy ${href}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        copyUrl(copyKey, href);
                                      }}
                                    >
                                      <ContentCopyIcon fontSize="inherit" />
                                    </IconButton>
                                  </Tooltip>
                                </Stack>
                              );
                            })}
                          </Stack>
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
