import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Divider,
  Stack,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  type ChequebookHealth,
  formatFillPercent,
  getErrorMessage,
  isStampExpiringSoon,
  isStampNearlyFull,
  nearlyFullConsequence,
  parsePlur,
  type StampHealth,
} from '@streaming-infra-manager/common';

import { useDeployments } from '../app/useDeploymentsStore';
import { SectionCard } from '../components/SectionCard';
import { formatTtl, shortHex } from '../format';
import type { Profile } from '../types';
import { BuyStampForm } from '../uploaders/BuyStampForm';
import {
  MoveBzzDialog,
  type MoveDirection,
} from '../uploaders/MoveBzzDialog';
import { NodeFunding } from '../uploaders/NodeFunding';
import { StampTable } from '../uploaders/StampTable';
import { buyStamp, setStamp, type BuyStampInput } from '../uploaders/stampApi';
import type { BeeUtils } from '../uploaders/useBeeUtils';
import { newBatchReach } from './newBatchReach';

/**
 * The deployment's own Bee node: what it holds, what it can still pay peers
 * with, which batches it has, and how to buy the next one.
 *
 * It takes the node data rather than fetching it, because the readiness
 * checklist above is derived from the same answer and the two must not disagree
 * about whether there is a usable stamp.
 */
export function StorageCard({
  profile,
  bee,
  stampHealth,
  chequebookHealth,
  defaultDepth,
  rung,
  onChanged,
}: {
  profile: Profile;
  bee: BeeUtils;
  stampHealth: StampHealth;
  chequebookHealth: ChequebookHealth | null;
  /** An ABR rung starts the buy form at the depth its bitrate wants. */
  defaultDepth?: number;
  /** The ABR rung this node publishes, when it is a pool member. */
  rung?: string | null;
  onChanged: () => void;
}) {
  const { chequebookFloorBzz } = useDeployments();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveDirection | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleBuy = (input: BuyStampInput) =>
    run(async () => {
      const { batchID } = await buyStamp(profile.name, input);
      bee.waitForStamp(batchID);
      await bee.reload();
    });

  const handleUse = (batchID: string) =>
    run(async () => {
      await setStamp(profile.name, batchID);
      onChanged();
    });

  const reach = newBatchReach(profile, rung);

  const nearlyFullAt =
    stampHealth.state === 'active' &&
    stampHealth.fillRatio !== null &&
    isStampNearlyFull(stampHealth.fillRatio, stampHealth.immutable)
      ? formatFillPercent(stampHealth.fillRatio)
      : null;

  const moveSourcePlur =
    moving === 'withdraw'
      ? parsePlur(bee.chequebook?.availableBalance)
      : parsePlur(bee.wallet?.bzzBalance);

  return (
    <SectionCard
      id="storage"
      title="Storage and funding"
      sub="this deployment's own Bee node pays for its uploads"
      actions={
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          disabled={bee.loading}
          onClick={() => void bee.reload()}
        >
          Refresh
        </Button>
      }
    >
      <Stack spacing={2}>
        {bee.loadError && <Alert severity="warning">{bee.loadError}</Alert>}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {stampHealth.dead && (
          <Alert severity="error">
            {stampHealth.state === 'expired'
              ? 'The postage batch this deployment pays with has expired. '
              : 'This Bee node does not hold the batch recorded for it, usually because the batch expired and was dropped. '}
            Uploads cannot be paid for until a new batch is bought below, which is
            set here once it is usable.
          </Alert>
        )}
        {stampHealth.state === 'full' && (
          <Alert severity="error">
            The postage batch this deployment pays with is full, and it cannot
            overwrite what it holds, so this Bee node refuses the uploads it is
            sent. Uploads cannot be paid for until a new batch is bought below,
            which is set here once it is usable.
          </Alert>
        )}
        {nearlyFullAt && (
          <Alert severity="warning">
            This batch is <strong>{nearlyFullAt} full</strong>.{' '}
            {nearlyFullConsequence(stampHealth.immutable, stampHealth.fillRatio)}{' '}
            Buy the next one below.
          </Alert>
        )}
        {!stampHealth.dead && stampHealth.state !== 'full' && isStampExpiringSoon(stampHealth.ttl) && (
          <Alert severity="warning">
            This batch runs out in <strong>{formatTtl(stampHealth.ttl)}</strong>.
            Buy the next one below before it does. Once a batch is spent its
            uploads fail and it cannot be revived.
          </Alert>
        )}
        {bee.waitingBatch && (
          <Alert severity="info" icon={<CircularProgress size={18} />}>
            Waiting for batch <code>{shortHex(bee.waitingBatch)}</code> to become
            usable. This takes a few minutes, and it is then set here
            automatically, unless another batch is set with <strong>Use</strong>{' '}
            first.{reach ? ` ${reach}` : ''}
          </Alert>
        )}

        <NodeFunding
          address={bee.address}
          wallet={bee.wallet}
          chequebook={bee.chequebook}
          chequebookHealth={chequebookHealth}
          loading={bee.loading}
          busy={busy}
          onFill={() => setMoving('fill')}
          onWithdraw={() => setMoving('withdraw')}
        />

        <Button sx={{ alignSelf: 'flex-start' }} onClick={() => setMoving('fill')}>Saved transfer</Button>

        <Divider />

        <StampTable
          stamps={bee.stamps}
          loading={bee.loading}
          currentStampId={profile.stamp_id}
          busy={busy}
          onUse={handleUse}
        />

        <Divider />

        <BuyStampForm
          busy={busy}
          onBuy={handleBuy}
          currentPrice={bee.chainState?.currentPrice ?? null}
          defaultDepth={defaultDepth}
          newBatchReach={reach}
        />
      </Stack>

      <MoveBzzDialog
        open={moving !== null}
        direction={moving ?? 'fill'}
        sourcePlur={moveSourcePlur}
        floorBzz={chequebookFloorBzz}
        profileName={profile.name}
        profileInstanceId={profile.instance_id}
        onClose={() => setMoving(null)}
      />
    </SectionCard>
  );
}
