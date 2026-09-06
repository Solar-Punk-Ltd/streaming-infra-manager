import { useCallback, useEffect, useState } from 'react';

import {
  getErrorMessage,
  type UserSummary,
} from '@streaming-infra-manager/common';

import { fetchUsers } from '../auth/authApi';

export interface UsersState {
  /** Null until the first answer arrives. */
  users: UserSummary[] | null;
  error: string | null;
  reload: () => Promise<void>;
}

export function useUsers(): UsersState {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await fetchUsers());
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { users, error, reload };
}
