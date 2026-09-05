import {
  Button,
  Link,
  Stack,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { useActions } from '../app/useDeploymentActions';
import { MONO_STACK } from '../app/theme';
import { ReadinessPill } from '../components/ReadinessPill';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { StatusDot } from '../components/StatusDot';
import { useServerHost } from '../ServerHostContext';
import type { Profile } from '../types';
import { useDeployments } from '../app/useDeploymentsStore';
import { clientUrl, hostFor, srtPublishUrl } from '../urls';
import { PrimaryAction } from './PrimaryAction';
import { readinessOf } from './readiness';
import {
  isRunning,
  isTransitional,
  SHAPE_LABEL,
  servicesOf,
  shapeOf,
  statusLabelOf,
} from './shape';

export function DeploymentRow({
  profile,
  rung,
  indented = false,
}: {
  profile: Profile;
  /** An ABR pool member leads its sub-line with the rung it publishes. */
  rung?: string | null;
  indented?: boolean;
}) {
  const serverHost = useServerHost();
  const { hostPassphrase } = useDeployments();
  const actions = useActions();
  const { openWizard, openEditDeployment } = useEditors();

  const readiness = readinessOf(profile);
  const shape = shapeOf(profile);
  const publishUrl = srtPublishUrl(profile, serverHost, hostPassphrase);
  const watchUrl = clientUrl(profile, serverHost);
  const copyable = publishUrl && readiness.tone === 'ok' ? publishUrl : null;

  const subParts = [
    SHAPE_LABEL[shape] + (rung ? ` · ${rung} rung` : ''),
    `slot ${profile.port_slot}`,
    hostFor(profile, serverHost),
    shape === 'custom' ? servicesOf(profile).join(' + ') : null,
  ].filter(Boolean);

  const menuItems: RowMenuItem[] = [
    { label: 'Open', onSelect: () => navigate(routes.deployment(profile.name)) },
    { label: 'Edit', onSelect: () => openEditDeployment(profile.name) },
  ];
  if (shape === 'stream' && isRunning(profile)) {
    menuItems.push({
      label: 'Create a viewer for this stream',
      onSelect: () =>
        openWizard({
          goal: 'viewer',
          feedStreamer: profile.name,
          name: `${profile.name}-viewer`,
        }),
    });
  }
  if (copyable) {
    menuItems.push({
      label: 'Copy publish URL',
      onSelect: () => {
        void navigator.clipboard.writeText(copyable).catch(() => undefined);
      },
    });
  }
  menuItems.push({
    label: 'Remove…',
    danger: true,
    separated: true,
    onSelect: () => actions.requestRemove(profile),
  });

  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer' }}
      onClick={() => navigate(routes.deployment(profile.name))}
    >
      <TableCell sx={{ width: 28, pl: indented ? 5 : 2 }}>
        <StatusDot
          tone={statusLabelOf(profile).tone}
          pulsing={isTransitional(profile)}
        />
      </TableCell>
      <TableCell>
        <Typography sx={{ fontFamily: MONO_STACK, fontWeight: 600, fontSize: 13 }}>
          {profile.name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {subParts.join(' · ')}
        </Typography>
      </TableCell>
      <TableCell>
        <ReadinessPill label={readiness.label} tone={readiness.tone} />
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {copyable && (
            <Button
              size="small"
              onClick={() => {
                void navigator.clipboard
                  .writeText(copyable)
                  .catch(() => undefined);
              }}
            >
              Copy publish URL
            </Button>
          )}
          {watchUrl && isRunning(profile) && (
            <Link href={watchUrl} target="_blank" rel="noopener" variant="body2">
              Watch
            </Link>
          )}
        </Stack>
      </TableCell>
      <TableCell align="right" onClick={(event) => event.stopPropagation()}>
        <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
          <PrimaryAction profile={profile} />
          <RowMenu items={menuItems} ariaLabel={`more actions for ${profile.name}`} />
        </Stack>
      </TableCell>
    </TableRow>
  );
}
