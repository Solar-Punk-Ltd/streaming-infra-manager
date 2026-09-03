import { Alert, Box, Chip, Divider, Stack, Typography } from '@mui/material';

import { beePublishersProblem } from '@streaming-infra-manager/common';

import { PublisherRungList, sortedPublisherRungs } from '../PublisherRungs';
import { useServerHost } from '../ServerHostContext';
import { srtPublishUrl } from '../urls';
import type { Profile } from '../types';
import { StreamPublishUrl } from './StreamPublishUrl';
import { UploaderShell } from './UploaderShell';

/**
 * An uploader that publishes to an ABR node pool.
 *
 * It uploads, so it belongs on this tab. It owns no postage, so there is
 * nothing here to buy, set, fund or release: the pool's rungs hold all of
 * that, bought on the pool's own card, quite possibly under a different manager
 * on a different machine.
 *
 * So this card has no actions at all, and that is the point of it being its own
 * component. It reports the two things a pool-backed uploader can actually
 * tell you — where to point OBS, and which node each rung's segments land on —
 * and nothing else. There is no `useBeeUtils` here, because there is no node of
 * its own to ask; and no Deploy uploader button, because `bee_publishers` set
 * means the stream-uploader is never held back for a stamp in the first place,
 * so the button could only ever have fired on a stack that was not running —
 * where the thing to press is Start, on the Deployments tab.
 */
export function PoolUploaderCard({
  profile,
  srtPassphrase,
}: {
  profile: Profile;
  srtPassphrase: string | null;
}) {
  const serverHost = useServerHost();
  const streamUrl = srtPublishUrl(profile, serverHost, srtPassphrase);
  const rungs = sortedPublisherRungs(profile.bee_publishers);

  return (
    <UploaderShell
      title={profile.name}
      status={profile.status}
      // Says why there is no stamp chip beside it, so a card with no postage on
      // it does not read as a card that failed to load any.
      badges={<Chip size="small" variant="outlined" label="Pool-backed" />}
    >
      <StreamPublishUrl streamUrl={streamUrl} />

      <Divider />

      <Box>
        <Typography variant="overline" color="text.secondary">
          Publishes to
        </Typography>
        {rungs ? (
          <Stack spacing={1}>
            <PublisherRungList rungs={rungs} showBatchIds />
            <Typography variant="caption" color="text.secondary">
              One Bee node per rung, each paying with its own postage batch.
              Those batches are bought and funded on the pool&rsquo;s card — on
              whichever manager owns the pool — so there is nothing to fund
              here.
            </Typography>
          </Stack>
        ) : (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {/* Everything created through the manager is validated on the way
                in, so reaching this means the row was changed behind its back.
                Worth naming rather than rendering an empty list: the uploader
                refuses to start on a pool it cannot parse. */}
            This uploader&rsquo;s pool string is not usable —{' '}
            {beePublishersProblem(profile.bee_publishers) ?? 'it is empty'}. Fix
            it with <strong>Modify</strong> on the Deployments tab; as it stands
            the uploader will not start.
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', wordBreak: 'break-all', mt: 1 }}
            >
              {profile.bee_publishers}
            </Typography>
          </Alert>
        )}
      </Box>
    </UploaderShell>
  );
}
