import { useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { canDeployUploader, deployUploader, hasStampId } from '../data';
import { srtPublishUrl } from '../urls';
import { buyStamp, setStamp } from './stampApi';
import type { BuyStampInput } from './stampApi';
import { useServerHost } from '../ServerHostContext';
import { StampRequiredChip } from '../StatusChip';
import type { Profile } from '../types';
import { NodeFunding } from './NodeFunding';
import { StampTable, shortHex } from './StampTable';
import { BuyStampForm } from './BuyStampForm';
import { StreamPublishUrl } from './StreamPublishUrl';
import { useBeeNode } from './useBeeNode';
import { useWaitForUsableStamp } from './useWaitForUsableStamp';

export function UploaderCard({
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

  const { address, wallet, stamps, loading, loadError, reload, refreshStamps } =
    useBeeNode(profile.name);
  const { waitingBatch, waitForStamp } = useWaitForUsableStamp(
    refreshStamps,
    hasStampId(profile),
  );

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBuyStamp = (input: BuyStampInput) =>
    runAction(async () => {
      const { batchID } = await buyStamp(profile.name, input);
      waitForStamp(batchID);
      await reload();
    });

  const handleUseStamp = (batchID: string) =>
    runAction(async () => {
      await setStamp(profile.name, batchID);
      onChanged();
    });

  const handleDeployUploader = () =>
    runAction(async () => {
      await deployUploader(profile.name);
      onChanged();
    });

  const stampChip = profile.pendingStamp ? (
    <StampRequiredChip />
  ) : hasStampId(profile) ? (
    <Chip size="small" color="success" variant="outlined" label="Stamp set" />
  ) : null;

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
          {stampChip}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => void reload()}
              disabled={loading}
            >
              Refresh
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button
              size="small"
              variant="contained"
              onClick={handleDeployUploader}
              disabled={busy || !canDeployUploader(profile)}
            >
              Deploy uploader
            </Button>
          </Stack>

          {loadError && <Alert severity="warning">{loadError}</Alert>}
          {actionError && (
            <Alert severity="error" onClose={() => setActionError(null)}>
              {actionError}
            </Alert>
          )}
          {waitingBatch && (
            <Alert severity="info" icon={<CircularProgress size={18} />}>
              Waiting for stamp <code>{shortHex(waitingBatch)}</code> to become
              usable — this can take a few minutes. It will be set automatically.
            </Alert>
          )}

          <StreamPublishUrl streamUrl={streamUrl} />

          <NodeFunding address={address} wallet={wallet} />

          <Divider />

          <StampTable
            stamps={stamps}
            loading={loading}
            currentStampId={profile.stamp_id}
            busy={busy}
            onUse={handleUseStamp}
          />

          <Divider />

          <BuyStampForm busy={busy} onBuy={handleBuyStamp} />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
