import { Stack, Typography } from '@mui/material';

import { ManagerAdminLinkCard } from '../adminLink/ManagerAdminLinkCard';
import { useManagerAdminLink } from '../adminLink/useManagerAdminLink';

/**
 * Settings of the manager itself rather than of one deployment or version:
 * today the web2 admin link every new uploader deployment starts with.
 */
export function ManagerSettingsPage() {
  const load = useManagerAdminLink();
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        What this manager gives the deployments it creates. A deployment that exists keeps its own settings, on its own page.
      </Typography>
      <ManagerAdminLinkCard load={load} />
    </Stack>
  );
}
