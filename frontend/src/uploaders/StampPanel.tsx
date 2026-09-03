import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  getErrorMessage,
  isBeeNodeOnly,
  isStampExpiringSoon,
  type StampHealth,
} from '@streaming-infra-manager/common';

import { canDeployUploader, deployUploader } from '../data';
import { formatTtl, shortHex } from '../format';
import type { Profile } from '../types';
import { BuyStampForm } from './BuyStampForm';
import { NodeFunding } from './NodeFunding';
import { StampTable } from './StampTable';
import { buyStamp, setStamp, type BuyStampInput } from './stampApi';
import type { BeeUtils } from './useBeeUtils';

/**
 * Everything an uploader's own postage needs: what the wallet holds, which
 * batches the node has, buying the next one, and releasing a stream-uploader
 * that was held back for want of a stamp.
 *
 * Split out of UploaderCard so that an uploader with no postage of its own can
 * be a card without any of this, rather than the same card with its buttons
 * disabled. It deliberately does *not* own `useBeeUtils`: the stamp chip in the
 * summary row is derived from the same node data, and a hook down here would
 * strand that chip inside a collapsed panel.
 */
export function StampPanel({
  profile,
  bee,
  stampHealth,
  onChanged,
  defaultDepth,
}: {
  profile: Profile;
  bee: BeeUtils;
  /**
   * Passed in rather than recomputed from `bee.stamps`: the summary chip and
   * the alerts below have to agree about the same batch, and two calls are two
   * things to keep in step.
   */
  stampHealth: StampHealth;
  onChanged: () => void;
  /** Starting depth for the buy form. See BuyStampForm.defaultDepth. */
  defaultDepth?: number;
}) {
  const { stamps, chainState, loading, loadError, reload, waitingBatch } = bee;

  // A bee-only profile — an ABR ladder rung, or any bare publish target — runs
  // no uploader: there is nothing to "deploy uploader" onto. It still funds a
  // wallet and buys a batch, which is the rest of this panel.
  const beeOnly = isBeeNodeOnly(profile);

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
      bee.waitForStamp(batchID);
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

  return (
    <>
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
            disabled={busy || !canDeployUploader(profile) || stampHealth.dead}
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
          <strong>{formatTtl(stampHealth.ttl)}</strong>. Buy the next one below
          and set it with <strong>Use</strong> before it does — once a batch is
          spent its uploads fail, and it cannot be revived.
        </Alert>
      )}
      {waitingBatch && (
        <Alert severity="info" icon={<CircularProgress size={18} />}>
          Waiting for stamp <code>{shortHex(waitingBatch)}</code> to become
          usable — this can take a few minutes. It will be set automatically.
        </Alert>
      )}

      <NodeFunding address={bee.address} wallet={bee.wallet} />

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
    </>
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
