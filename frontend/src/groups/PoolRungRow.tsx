import { Button, Stack, TableCell, TableRow, Typography } from '@mui/material';

import {
  DEFAULT_ABR_LADDER,
  hasStampId,
  isDeadStampState,
  type LadderRungState,
} from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { ReadinessPill } from '../components/ReadinessPill';
import { RowMenu } from '../components/RowMenu';
import { StatusDot } from '../components/StatusDot';
import { PrimaryAction } from '../deployments/PrimaryAction';
import { readinessOf } from '../deployments/readiness';
import { isRunning, isTransitional, statusLabelOf } from '../deployments/shape';
import {
  BZZ_DECIMALS,
  formatTokenBalance,
  formatTtl,
  XDAI_DECIMALS,
} from '../format';
import type { Profile } from '../types';
import { useBeeUtils } from '../uploaders/useBeeUtils';

const COORDINATOR_RUNG = DEFAULT_ABR_LADDER[0].name;

export function PoolRungRow({
  rung,
  profile,
  rungState,
}: {
  rung: string;
  profile: Profile;
  /** What the manager's own assembly says about this rung, when it answered. */
  rungState: LadderRungState | null;
}) {
  const bee = useBeeUtils(profile);
  const actions = useActions();
  const { openEditDeployment } = useEditors();

  const spec = DEFAULT_ABR_LADDER.find((entry) => entry.name === rung);
  const readiness = readinessOf(profile);
  const bzz = bee.wallet?.bzzBalance;
  const bzzEmpty = !bzz || bzz === '0';
  const needsStamp = isRunning(profile) && !hasStampId(profile);

  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer' }}
      onClick={() => navigate(routes.deployment(profile.name))}
    >
      <TableCell sx={{ width: 28 }}>
        <StatusDot
          tone={statusLabelOf(profile).tone}
          pulsing={isTransitional(profile)}
        />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap">
          <Typography sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
            {rung}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {spec ? `${spec.width}×${spec.height} · ${spec.kbps} kbps` : ''}
            {rung === COORDINATOR_RUNG ? ' · coordinator' : ''}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {profile.name} · slot {profile.port_slot}
        </Typography>
      </TableCell>
      <TableCell>
        <ReadinessPill label={readiness.label} tone={readiness.tone} />
      </TableCell>
      <TableCell>
        <Typography variant="caption" sx={{ fontFamily: MONO_STACK }}>
          xDAI {formatTokenBalance(bee.wallet?.nativeTokenBalance, XDAI_DECIMALS)}
        </Typography>
        <Typography
          variant="caption"
          component="div"
          sx={{ fontFamily: MONO_STACK }}
          color={bzzEmpty ? 'warning.main' : 'text.primary'}
        >
          BZZ {formatTokenBalance(bzz, BZZ_DECIMALS)}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="caption">{stampText(profile, rungState)}</Typography>
      </TableCell>
      <TableCell align="right" onClick={(event) => event.stopPropagation()}>
        <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
          {needsStamp ? (
            <Button
              size="small"
              variant="contained"
              onClick={() => navigate(routes.deploymentStorage(profile.name))}
            >
              Buy stamp
            </Button>
          ) : (
            <PrimaryAction profile={profile} />
          )}
          <RowMenu
            ariaLabel={`more actions for ${profile.name}`}
            items={[
              {
                label: 'Open',
                onSelect: () => navigate(routes.deployment(profile.name)),
              },
              {
                label: 'Edit',
                onSelect: () => openEditDeployment(profile.name),
              },
              {
                label: 'Remove…',
                danger: true,
                separated: true,
                onSelect: () => actions.requestRemove(profile),
              },
            ]}
          />
        </Stack>
      </TableCell>
    </TableRow>
  );
}

function stampText(
  profile: Profile,
  rungState: LadderRungState | null,
): string {
  if (rungState?.stampState === 'active') {
    return rungState.stampTtl != null
      ? `${formatTtl(rungState.stampTtl)} left`
      : 'active';
  }
  if (rungState && isDeadStampState(rungState.stampState)) return 'expired';
  if (rungState?.stampState === 'pending') return 'settling';
  return hasStampId(profile) ? 'set' : 'none';
}
