import { Alert, Button, Stack, Typography } from '@mui/material';

import { beePublishersProblem } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { MONO_STACK } from '../app/theme';
import { SectionCard } from '../components/SectionCard';
import { PublisherRungList, sortedPublisherRungs } from '../PublisherRungs';
import type { Profile } from '../types';

/** Where an ABR uploader's four rungs land, one Bee node each. */
export function PoolTargetCard({ profile }: { profile: Profile }) {
  const { openEditDeployment } = useEditors();
  const rungs = sortedPublisherRungs(profile.bee_publishers);

  return (
    <SectionCard
      title="Publishes to"
      sub="one Bee node per quality rung, possibly in another manager"
    >
      {rungs ? (
        <Stack spacing={1.25}>
          <PublisherRungList rungs={rungs} showBatchIds />
          <Typography variant="caption" color="text.secondary">
            Those nodes hold the postage. Funding and stamps are managed on the
            pool's own page, on whichever manager owns it. Nothing to fund here.
          </Typography>
        </Stack>
      ) : (
        <Stack spacing={1.25}>
          <Alert
            severity="warning"
            action={
              <Button size="small" onClick={() => openEditDeployment(profile.name)}>
                Edit
              </Button>
            }
          >
            The pool string on this deployment cannot be used.{' '}
            {beePublishersProblem(profile.bee_publishers) ?? 'It is empty.'} Fix
            it under Edit, or the uploader will refuse to start.
          </Alert>
          {profile.bee_publishers && (
            <Typography
              variant="body2"
              sx={{ fontFamily: MONO_STACK, wordBreak: 'break-all' }}
            >
              {profile.bee_publishers}
            </Typography>
          )}
        </Stack>
      )}
    </SectionCard>
  );
}
