import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  getErrorMessage,
  type UserSummary,
} from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { removeUser, revokeSessions } from '../auth/authApi';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';
import { formatDateTime } from '../format';

const NEVER_SIGNED_IN = 'Never';

const CANNOT_REMOVE = {
  self: 'You cannot remove your own account. Ask another user to remove it.',
  last: 'This is the last user. Removing it would lock everyone out.',
  none: '',
} as const;

const NO_SESSIONS = 'This user has no open sessions.';

// A disabled button receives no pointer events, so each Tooltip below wraps its
// button in a span that does. Without it the reason a button is greyed out is
// on screen for nobody, mouse or screen reader alike.

function removalBlockedBecause(
  user: UserSummary,
  currentUsername: string,
  total: number,
): keyof typeof CANNOT_REMOVE {
  if (user.username === currentUsername) return 'self';
  if (total <= 1) return 'last';
  return 'none';
}

/**
 * Who can sign in, and the two things that can be done to each of them.
 *
 * Both actions ask first: removing a user cannot be undone, and signing one out
 * everywhere interrupts whatever they were in the middle of.
 */
export function UsersCard({
  users,
  error,
  currentUsername,
  reload,
}: {
  users: UserSummary[] | null;
  error: string | null;
  currentUsername: string;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const run = async (
    user: UserSummary,
    done: string,
    action: (id: number) => Promise<void>,
  ) => {
    setBusyId(user.id);
    try {
      await action(user.id);
      toast(done, 'success');
      await reload();
    } catch (caught) {
      toast(getErrorMessage(caught), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const askRemove = (user: UserSummary) =>
    setConfirm({
      title: `Remove ${user.username}?`,
      body: 'They will be signed out everywhere and will not be able to sign in again. This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () =>
        void run(user, `Removed ${user.username}`, removeUser),
    });

  const askRevoke = (user: UserSummary) =>
    setConfirm({
      title: `Sign ${user.username} out everywhere?`,
      body:
        user.username === currentUsername
          ? 'Every browser you are signed in with is asked for the password again, this one included.'
          : 'Every browser they are signed in with is asked for the password again.',
      confirmLabel: 'Sign out everywhere',
      onConfirm: () =>
        void run(user, `Signed ${user.username} out everywhere`, revokeSessions),
    });

  return (
    <SectionCard
      title="Users"
      sub="Everyone who can sign in to this manager"
      flush
    >
      {error && (
        <Alert
          severity="error"
          sx={{ m: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          Could not read the users from the manager. {error}
        </Alert>
      )}

      {!users && !error && (
        <Stack alignItems="center" sx={{ py: 5 }}>
          <CircularProgress size={24} />
        </Stack>
      )}

      {users && (
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>User</TableCell>
              <TableCell>Last sign in</TableCell>
              <TableCell align="right">Open sessions</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map((user) => {
              const blocked = removalBlockedBecause(
                user,
                currentUsername,
                users.length,
              );
              const busy = busyId === user.id;

              return (
                <TableRow key={user.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {user.username}
                      {user.username === currentUsername && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ ml: 0.75 }}
                        >
                          you
                        </Typography>
                      )}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {user.lastLoginAt
                        ? formatDateTime(user.lastLoginAt)
                        : NEVER_SIGNED_IN}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{user.sessions}</TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={0.5}
                      justifyContent="flex-end"
                    >
                      <Tooltip title={user.sessions === 0 ? NO_SESSIONS : ''}>
                        <Box component="span">
                          <Button
                            size="small"
                            disabled={busy || user.sessions === 0}
                            onClick={() => askRevoke(user)}
                          >
                            Sign out everywhere
                          </Button>
                        </Box>
                      </Tooltip>
                      <Tooltip title={CANNOT_REMOVE[blocked]}>
                        <Box component="span">
                          <Button
                            size="small"
                            color="error"
                            disabled={busy || blocked !== 'none'}
                            onClick={() => askRemove(user)}
                          >
                            Remove
                          </Button>
                        </Box>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </SectionCard>
  );
}
