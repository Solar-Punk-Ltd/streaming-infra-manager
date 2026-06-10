import { useCallback, useEffect, useState } from 'react';
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
import {
  type BeeAddress,
  type BeeWallet,
  buyStamp,
  fetchStampAddress,
  fetchStamps,
  fetchStampWallet,
  setStamp,
} from './stampApi';
import type { BuyStampInput } from './stampApi';
import { useServerHost } from '../ServerHostContext';
import { StampRequiredChip } from '../StatusChip';
import { CopyButton } from '../CopyButton';
import type { Profile } from '../types';
import { NodeFunding } from './NodeFunding';
import { StampTable, shortHex, sameBatch } from './StampTable';
import { BuyStampForm } from './BuyStampForm';

export function UploaderCard({
  profile,
  onChanged,
  srtPassphrase,
}: {
  profile: Profile;
  onChanged: () => void;
  srtPassphrase: string | null;
}) {
  const [address, setAddress] = useState<BeeAddress | null>(null);
  const [wallet, setWallet] = useState<BeeWallet | null>(null);
  const [stamps, setStamps] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingBatch, setWaitingBatch] = useState<string | null>(null);

  const serverHost = useServerHost();
  const streamUrl = srtPublishUrl(profile, serverHost, srtPassphrase);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [a, w, s] = await Promise.allSettled([
      fetchStampAddress(profile.name),
      fetchStampWallet(profile.name),
      fetchStamps(profile.name),
    ]);
    if (a.status === 'fulfilled') setAddress(a.value);
    if (w.status === 'fulfilled') setWallet(w.value);
    if (s.status === 'fulfilled') setStamps(s.value);
    const firstFail = [a, w, s].find((r) => r.status === 'rejected');
    if (firstFail && firstFail.status === 'rejected') {
      setLoadError(
        `bee node unreachable — ${getErrorMessage(firstFail.reason)}`,
      );
    }
    setLoading(false);
  }, [profile.name]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!waitingBatch) return;
    const batch = waitingBatch;
    let attempts = 0;
    const MAX_ATTEMPTS = 120; // ~10 min at 5s
    const id = setInterval(async () => {
      attempts += 1;
      try {
        const fresh = await fetchStamps(profile.name);
        setStamps(fresh);
        const match = fresh.find((s) => sameBatch(s.batchID, batch));
        if ((match && match.usable) || attempts >= MAX_ATTEMPTS) {
          setWaitingBatch(null);
        }
      } catch {
        if (attempts >= MAX_ATTEMPTS) setWaitingBatch(null);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [waitingBatch, profile.name]);

  const stampSet = !!profile.stamp_id?.trim();
  useEffect(() => {
    if (waitingBatch && stampSet) setWaitingBatch(null);
  }, [stampSet, waitingBatch]);

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onBuy = (input: BuyStampInput) =>
    runAction(async () => {
      const { batchID } = await buyStamp(profile.name, input);
      setWaitingBatch(batchID);
      await load();
    });

  const onUse = (batchID: string) =>
    runAction(async () => {
      await setStamp(profile.name, batchID);
      onChanged();
    });

  const onDeployUploader = () =>
    runAction(async () => {
      await deployUploader(profile.name);
      onChanged();
    });

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
          {profile.pendingStamp ? (
            <StampRequiredChip />
          ) : hasStampId(profile) ? (
            <Chip
              size="small"
              color="success"
              variant="outlined"
              label="Stamp set"
            />
          ) : null}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button
              size="small"
              variant="contained"
              onClick={onDeployUploader}
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

          <Box>
            <Typography variant="overline" color="text.secondary">
              Stream here (SRT publish)
            </Typography>
            {streamUrl ? (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                >
                  {streamUrl}
                </Typography>
                <CopyButton value={streamUrl} label="stream URL" />
              </Stack>
            ) : (
              <Typography variant="body2" color="text.disabled">
                Deploy the streamer to get its SRT port.
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              Point OBS / FFmpeg here. Change <code>live/stream</code> to your
              app/stream; if the deployment sets an SRT passphrase, append{' '}
              <code>&amp;passphrase=…</code>.
            </Typography>
          </Box>

          <NodeFunding address={address} wallet={wallet} />

          <Divider />

          <StampTable
            stamps={stamps}
            loading={loading}
            currentStampId={profile.stamp_id}
            busy={busy}
            onUse={onUse}
          />

          <Divider />

          <BuyStampForm busy={busy} onBuy={onBuy} />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
