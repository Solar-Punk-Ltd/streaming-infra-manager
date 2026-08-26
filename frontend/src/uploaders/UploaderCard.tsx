import { useState, type ReactNode } from 'react';
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

import {
  getErrorMessage,
  isBeeNodeOnly,
} from '@streaming-infra-manager/common';

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
import { useBeeUtils } from './useBeeUtils';

export function UploaderCard({
  profile,
  onChanged,
  srtPassphrase,
  label,
  badges,
  defaultDepth,
  nested = false,
}: {
  profile: Profile;
  onChanged: () => void;
  srtPassphrase: string | null;
  /** Shown instead of the profile name — an ABR rung leads with its rung. */
  label?: ReactNode;
  /** Extra chips in the summary, before the stamp chip. */
  badges?: ReactNode;
  /** Starting depth for the buy form. See BuyStampForm.defaultDepth. */
  defaultDepth?: number;
  /** Rendered inside another card: drop the elevation so nesting reads as hierarchy. */
  nested?: boolean;
}) {
  const serverHost = useServerHost();
  // A bee-only profile — an ABR ladder rung, or any bare publish target — runs no
  // uploader and no media engine: it has nothing to ingest a stream on, and
  // nothing to "deploy uploader" onto. It still funds a wallet and buys a batch,
  // which is the rest of this card.
  const beeOnly = isBeeNodeOnly(profile);
  const streamUrl = beeOnly
    ? null
    : srtPublishUrl(profile, serverHost, srtPassphrase);

  const {
    address,
    wallet,
    stamps,
    chainState,
    loading,
    loadError,
    reload,
    waitingBatch,
    waitForStamp,
  } = useBeeUtils(profile);

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
    <Accordion
      disableGutters={nested}
      elevation={nested ? 0 : undefined}
      sx={nested ? { border: 1, borderColor: 'divider' } : undefined}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ width: '100%' }}
        >
          <Typography sx={{ fontFamily: 'monospace', flexGrow: 1 }}>
            {label ?? profile.name}
          </Typography>
          {badges}
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
            {!beeOnly && (
              <Button
                size="small"
                variant="contained"
                onClick={handleDeployUploader}
                disabled={busy || !canDeployUploader(profile)}
              >
                Deploy uploader
              </Button>
            )}
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

          {!beeOnly && <StreamPublishUrl streamUrl={streamUrl} />}

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

          <BuyStampForm
            busy={busy}
            onBuy={handleBuyStamp}
            currentPrice={chainState?.currentPrice ?? null}
            defaultDepth={defaultDepth}
          />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
