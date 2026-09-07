import { Stack, Typography } from '@mui/material';

import { useSession } from '../app/useSession';

import { AddUserCard } from './AddUserCard';
import { ChangePasswordCard } from './ChangePasswordCard';
import { UsersCard } from './UsersCard';
import { useUsers } from './useUsers';

/**
 * Who can sign in. A user who can manage users adds and removes the others
 * and signs anyone out. Everyone else sees the list, and can change their own
 * password and sign themselves out everywhere.
 */
export function AccessPage() {
  const session = useSession();
  const { users, error, reload } = useUsers();

  const currentUsername =
    session.state.status === 'signedIn' ? session.state.username : '';
  const canManage =
    session.state.status === 'signedIn' && session.state.isAdmin;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {canManage
          ? 'You can add and remove users here.'
          : 'Only a user who can manage users adds or removes one.'}{' '}
        A session lasts twelve hours of inactivity, and fourteen days at most.
      </Typography>

      <UsersCard
        users={users}
        error={error}
        currentUsername={currentUsername}
        canManage={canManage}
        reload={reload}
      />
      {canManage && <AddUserCard onAdded={reload} />}
      <ChangePasswordCard onChanged={reload} />
    </Stack>
  );
}
