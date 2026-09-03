import { useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import {
  beePublishersProblem,
  getErrorMessage,
  PUBLISHABLE_RUNG_STATUS,
} from '@streaming-infra-manager/common';

import { canDeployUploader, deployUploader } from '../data';
import { PublisherRungList, sortedPublisherRungs } from '../PublisherRungs';
import { useServerHost } from '../ServerHostContext';
import { StatusChip } from '../StatusChip';
import { srtPublishUrl } from '../urls';
import type { Profile } from '../types';
import { StreamPublishUrl } from './StreamPublishUrl';

/**
 * An uploader that publishes to an ABR node pool.
 *
 * It uploads, so it belongs on this tab; it owns no postage, so almost nothing
 * from `UploaderCard` applies. There is no wallet to fund, no batch list to
 * read and no batch to buy — the pool's rungs hold all of that, bought on the
 * pool's own card, quite possibly under a different manager on a different
 * machine.
 *
 * A separate component rather than a flag on `UploaderCard`, because that card
 * calls `useBeeUtils` unconditionally — hooks cannot be conditional — and those
 * four requests would go to a Bee node this profile does not run. Every card
 * would render "bee node unreachable" over a deployment that is working fine.
 *
 * What is left is the two things a pool-backed uploader can actually tell you:
 * where to point OBS, and which node each rung's segments end up on.
 */
export function PoolUploaderCard({
  profile,
  onChanged,
  srtPassphrase,
}: {
  profile: Profile;
  onChanged: () => void;
  srtPassphrase: string | null;
}) {
  const serverHost = useServerHost();
  const streamUrl = srtPublishUrl(profile, serverHost, srtPassphrase);
  const rungs = sortedPublisherRungs(profile.bee_publishers);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleDeployUploader = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await deployUploader(profile.name);
      onChanged();
    } catch (e) {
      setActionError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Same rule as UploaderCard: a chip on every healthy row buries the one row
  // that needs attention, and the Deployments tab shows status unconditionally.
  const statusChip =
    profile.status === PUBLISHABLE_RUNG_STATUS ? null : (
      <StatusChip status={profile.status} />
    );

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ width: '100%' }}
        >
          <Typography sx={{ fontFamily: 'monospace', flexGrow: 1 }}>
            {profile.name}
          </Typography>
          {/* Says why there is no stamp chip beside it, so a card with no
              postage on it does not read as a card that failed to load one. */}
          <Chip size="small" variant="outlined" label="Pool-backed" />
          {statusChip}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Box sx={{ flexGrow: 1 }} />
            <Button
              size="small"
              variant="contained"
              onClick={handleDeployUploader}
              // `canDeployUploader` only asks whether a pool string is
              // present, not whether it parses. writeProfileEnv refuses an
              // unusable one, so the deploy would fail with a clear error —
              // but the card has already worked out that it will, and the
              // warning below says so. Better not to offer it.
              disabled={busy || !canDeployUploader(profile) || !rungs}
            >
              Deploy uploader
            </Button>
          </Stack>

          {actionError && (
            <Alert severity="error" onClose={() => setActionError(null)}>
              {actionError}
            </Alert>
          )}

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
                  Those batches are bought and funded on the pool's card — on
                  whichever manager owns the pool — so there is nothing to fund
                  here.
                </Typography>
              </Stack>
            ) : (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {/* Everything created through the manager is validated on the
                    way in, so reaching this means the row was changed behind
                    its back. Worth naming rather than rendering an empty list:
                    the uploader refuses to start on a pool it cannot parse. */}
                This uploader&rsquo;s pool string is not usable —{' '}
                {beePublishersProblem(profile.bee_publishers) ??
                  'it is empty'}
                . Fix it with <strong>Modify</strong> on the Deployments tab; as
                it stands the uploader will not start.
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                    mt: 1,
                  }}
                >
                  {profile.bee_publishers}
                </Typography>
              </Alert>
            )}
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
