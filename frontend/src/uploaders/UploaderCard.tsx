import type { ReactNode } from 'react';
import { Chip } from '@mui/material';

import {
  isBeeNodeOnly,
  isStampExpiringSoon,
  stampHealthFrom,
  type StampHealth,
} from '@streaming-infra-manager/common';

import { formatTtl } from '../format';
import { useServerHost } from '../ServerHostContext';
import { StampRequiredChip } from '../StatusChip';
import { srtPublishUrl } from '../urls';
import type { Profile } from '../types';
import { StampPanel } from './StampPanel';
import { StreamPublishUrl } from './StreamPublishUrl';
import { UploaderShell } from './UploaderShell';
import { useBeeUtils } from './useBeeUtils';

/**
 * An uploader that owns its postage: it holds a wallet, buys its own batches
 * and pays for its own uploads.
 *
 * The publish URL and the postage are two separate panels, because a
 * pool-backed uploader has the first and none of the second — see
 * PoolUploaderCard.
 */
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
  // A bee-only profile — an ABR ladder rung, or any bare publish target — runs
  // no media engine, so it has nothing to ingest a stream on and no URL to
  // publish to. It still funds a wallet and buys a batch: that is StampPanel.
  const beeOnly = isBeeNodeOnly(profile);
  const streamUrl = beeOnly
    ? null
    : srtPublishUrl(profile, serverHost, srtPassphrase);

  // Stays here rather than inside StampPanel: the chip below is derived from
  // the same node data, and a hook in the panel would strand it inside a
  // collapsed accordion.
  const bee = useBeeUtils(profile);

  // A set `stamp_id` says which batch this uploader was pointed at, not that the
  // batch still pays: batches are finite leases and nothing writes their expiry
  // back. So the chip, the warning and the deploy button all read the node.
  const stampHealth = stampHealthFrom(profile.stamp_id, bee.stamps);

  const stampChip = profile.pendingStamp ? (
    <StampRequiredChip />
  ) : (
    <StampStateChip health={stampHealth} />
  );

  return (
    <UploaderShell
      title={label ?? profile.name}
      status={profile.status}
      badges={badges}
      trailing={stampChip}
      nested={nested}
    >
      {!beeOnly && <StreamPublishUrl streamUrl={streamUrl} />}
      <StampPanel
        profile={profile}
        bee={bee}
        stampHealth={stampHealth}
        onChanged={onChanged}
        defaultDepth={defaultDepth}
      />
    </UploaderShell>
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
