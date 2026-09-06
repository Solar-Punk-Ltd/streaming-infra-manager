import { Stack, Typography } from '@mui/material';

import { useSession } from '../app/useSession';

import { AddUserCard } from './AddUserCard';
import { ChangePasswordCard } from './ChangePasswordCard';
import { UsersCard } from './UsersCard';
import { useUsers } from './useUsers';

/**
 * Who can sign in. Everyone signed in is equal here: anyone can add a user,
 * remove another, or sign one out everywhere.
 */
export function AccessPage() {
  const session = useSession();
  const { users, error, reload } = useUsers();

  const currentUsername =
    session.state.status === 'signedIn' ? session.state.username : '';

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Everyone here has the same rights. A session lasts twelve hours of
        inactivity, and fourteen days at most.
      </Typography>

      <UsersCard
        users={users}
        error={error}
        currentUsername={currentUsername}
        reload={reload}
      />
      <AddUserCard onAdded={reload} />
      <ChangePasswordCard onChanged={reload} />
    </Stack>
  );
}
