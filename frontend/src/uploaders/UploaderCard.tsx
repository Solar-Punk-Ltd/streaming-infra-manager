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
  isStampExpiringSoon,
  PUBLISHABLE_RUNG_STATUS,
  stampHealthFrom,
  type StampHealth,
} from '@streaming-infra-manager/common';

import { canDeployUploader, deployUploader } from '../data';
import { formatTtl } from '../format';
import { srtPublishUrl } from '../urls';
import { buyStamp, setStamp } from './stampApi';
import type { BuyStampInput } from './stampApi';
import { useServerHost } from '../ServerHostContext';
import { StampRequiredChip, StatusChip } from '../StatusChip';
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
    stampsLoaded,
    chainState,
    loading,
    loadError,
    reload,
    waitingBatch,
    waitForStamp,
  } = useBeeUtils(profile);

  // A set `stamp_id` says which batch this uploader was pointed at, not that the
  // batch still pays: batches are finite leases and nothing writes their expiry
  // back. So the chip, the warning and the deploy button all read the node.
  const stampHealth = stampHealthFrom(
    profile.stamp_id,
    stampsLoaded ? stamps : null,
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
  ) : (
    <StampStateChip health={stampHealth} />
  );

  // Only when it is not running: this card is about batches, and a chip on every
  // healthy row would bury the one row that needs attention. The Deployments tab
  // is where status is shown unconditionally.
  const statusChip =
    profile.status === PUBLISHABLE_RUNG_STATUS ? null : (
      <StatusChip status={profile.status} />
    );

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
          {statusChip}
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
                disabled={
                  busy || !canDeployUploader(profile) || stampHealth.dead
                }
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
          {stampHealth.dead && <DeadStampAlert health={stampHealth} />}
          {!stampHealth.dead && isStampExpiringSoon(stampHealth.ttl) && (
            <Alert severity="warning">
              This uploader’s batch runs out in{' '}
              <strong>{formatTtl(stampHealth.ttl)}</strong>. Buy the next one
              below and set it with <strong>Use</strong> before it does — once a
              batch is spent its uploads fail, and it cannot be revived.
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

const STAMP_CHIP: Record<
  StampHealth['state'],
  { label: string; color: 'success' | 'warning' | 'error' | 'default' } | null
> = {
  none: null,
  active: { label: 'Stamp set', color: 'success' },
  pending: { label: 'Stamp settling', color: 'warning' },
  expired: { label: 'Stamp expired', color: 'error' },
  // Not "expired": a batch the node never knew (a mistyped id, a rebuilt node)
  // lands here too, and the alert below carries the likely cause.
  gone: { label: 'Stamp not on node', color: 'error' },
  // The batch may well be fine; we simply could not ask. Saying "set" here is
  // what produced a green ladder with nothing behind it.
  unknown: { label: 'Stamp unverified', color: 'default' },
};

function StampStateChip({ health }: { health: StampHealth }) {
  const expiringSoon = health.ok && isStampExpiringSoon(health.ttl);
  const chip = expiringSoon
    ? { label: `Expires in ${formatTtl(health.ttl)}`, color: 'warning' as const }
    : STAMP_CHIP[health.state];
  if (!chip) return null;
  return (
    <Chip
      size="small"
      color={chip.color}
      variant="outlined"
      label={chip.label}
      title={
        health.ttl != null && health.ttl > 0
          ? `${formatTtl(health.ttl)} left on this batch`
          : undefined
      }
    />
  );
}

/**
 * A batch that has run out cannot be topped up from here — bee has no
 * extend-batch call wired into this manager — so the only way forward is a new
 * batch, which is what this says.
 */
function DeadStampAlert({ health }: { health: StampHealth }) {
  return (
    <Alert severity="error">
      {health.state === 'expired'
        ? 'The postage batch this uploader pays with has expired. '
        : 'This uploader’s bee node does not hold the batch recorded for it — the usual cause is a batch that expired and was dropped. '}
      Uploads cannot be paid for until a new batch is bought below and set with{' '}
      <strong>Use</strong>.
    </Alert>
  );
}
