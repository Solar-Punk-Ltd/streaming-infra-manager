import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { canDeployUploader, deployUploader, hasStampId } from '../data';
import { srtPublishUrl } from '../urls';
import {
  type BeeAddress,
  type BeeStamp,
  type BeeWallet,
  buyStamp,
  fetchStampAddress,
  fetchStamps,
  fetchStampWallet,
  setStamp,
} from './stampApi';
import { formatTokenBalance, formatTtl } from '../format';
import { useServerHost } from '../ServerHostContext';
import { StampRequiredChip } from '../StatusChip';
import { CopyButton } from '../CopyButton';
import type { Profile } from '../types';

const BZZ_DECIMALS = 16;
const XDAI_DECIMALS = 18;
const DEFAULT_DEPTH = '17';

function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

function sameBatch(a: string, b: string): boolean {
  return a.replace(/^0x/, '') === b.replace(/^0x/, '');
}

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
  const [stamps, setStamps] = useState<BeeStamp[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [amount, setAmount] = useState('');
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [label, setLabel] = useState('');
  const [immutable, setImmutable] = useState(false);
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

  // While a freshly-bought batch is settling, poll the stamp list so its
  // "usable" flag flips live. The backend auto-sets it when usable; clear once
  // that lands (profile gains a stamp) or the batch reports usable.
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

  // The backend pushes profile.changed (SSE) when it auto-sets the stamp.
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

  const onBuy = () =>
    runAction(async () => {
      const { batchID } = await buyStamp(profile.name, {
        amount: amount.trim(),
        depth: Number(depth),
        label: label.trim() || undefined,
        immutable,
      });
      setAmount('');
      setLabel('');
      // Batch becomes usable after a few blocks — track it and poll.
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

  const amountValid = /^[1-9][0-9]*$/.test(amount.trim());
  const depthNum = Number(depth);
  const depthValid =
    Number.isInteger(depthNum) && depthNum >= 17 && depthNum <= 40;
  const canBuy = !busy && amountValid && depthValid;

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

          <Box>
            <Typography variant="overline" color="text.secondary">
              Node funding address (Gnosis Chain)
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
              >
                {address?.ethereum ?? '—'}
              </Typography>
              {address?.ethereum && (
                <CopyButton value={address.ethereum} label="address" />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Send xDAI (gas) and BZZ (storage) here, then buy a stamp.
            </Typography>
          </Box>

          <Stack direction="row" spacing={3}>
            <Box>
              <Typography variant="overline" color="text.secondary">
                xDAI
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {formatTokenBalance(wallet?.nativeTokenBalance, XDAI_DECIMALS)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="overline" color="text.secondary">
                BZZ
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {formatTokenBalance(wallet?.bzzBalance, BZZ_DECIMALS)}
              </Typography>
            </Box>
          </Stack>

          <Divider />

          <Box>
            <Typography variant="overline" color="text.secondary">
              Postage stamps
            </Typography>
            <Paper variant="outlined" sx={{ mt: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Batch ID</TableCell>
                    <TableCell align="right">Depth</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Usable</TableCell>
                    <TableCell>TTL</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {stamps.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <Typography variant="body2" color="text.disabled">
                          {loading ? 'Loading…' : 'No stamps on this node yet.'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    stamps.map((s) => {
                      const isCurrent =
                        !!profile.stamp_id &&
                        sameBatch(profile.stamp_id, s.batchID);
                      return (
                        <TableRow key={s.batchID}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>
                            <Stack
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                            >
                              <span>{shortHex(s.batchID)}</span>
                              <CopyButton value={s.batchID} label="batch id" />
                            </Stack>
                          </TableCell>
                          <TableCell align="right">{s.depth}</TableCell>
                          <TableCell
                            align="right"
                            sx={{ fontFamily: 'monospace' }}
                          >
                            {s.amount}
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              variant="outlined"
                              color={s.usable ? 'success' : 'warning'}
                              label={s.usable ? 'usable' : 'pending'}
                            />
                          </TableCell>
                          <TableCell>{formatTtl(s.batchTTL)}</TableCell>
                          <TableCell align="right">
                            {isCurrent ? (
                              <Chip size="small" label="in use" />
                            ) : (
                              <Button
                                size="small"
                                disabled={busy || !s.usable}
                                onClick={() => onUse(s.batchID)}
                              >
                                Use
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </Paper>
          </Box>

          <Divider />

          <Box>
            <Typography variant="overline" color="text.secondary">
              Buy a stamp
            </Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ sm: 'flex-start' }}
              sx={{ mt: 1 }}
            >
              <TextField
                label="Amount (PLUR / chunk)"
                size="small"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                error={amount.length > 0 && !amountValid}
                helperText={
                  amount.length > 0 && !amountValid
                    ? 'positive integer'
                    : 'per-chunk amount; higher = longer life'
                }
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
              />
              <TextField
                label="Depth"
                size="small"
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
                error={!depthValid}
                helperText={!depthValid ? '17–40' : 'batch size (2^depth)'}
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
              />
              <TextField
                label="Label"
                size="small"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                helperText="optional"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={immutable}
                    onChange={(e) => setImmutable(e.target.checked)}
                  />
                }
                label="Immutable"
              />
              <Button
                variant="contained"
                onClick={onBuy}
                disabled={!canBuy}
                startIcon={busy ? <CircularProgress size={16} /> : null}
              >
                Buy
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              A new batch takes a few minutes to become usable. Refresh, then
              <strong> Use</strong> it and <strong>Deploy uploader</strong>.
              Need funds?{' '}
              <Link
                href="https://docs.ethswarm.org/docs/bee/installation/fund-your-node"
                target="_blank"
                rel="noopener"
              >
                Funding guide
              </Link>
              .
            </Typography>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
