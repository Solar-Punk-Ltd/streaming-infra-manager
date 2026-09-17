import {
  Button,
  Link,
  Stack,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';

import type { ChequebookHealth, StampHealth } from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { navigate, routes } from '../app/router';
import { useActions } from '../app/useDeploymentActions';
import { MONO_STACK } from '../app/theme';
import { ReadinessPill } from '../components/ReadinessPill';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { StatusDot } from '../components/StatusDot';
import { useServerHost } from '../ServerHostContext';
import type { Profile } from '../types';
import { clientUrl, hostFor } from '../urls';
import { PrimaryAction } from './PrimaryAction';
import { readinessOf } from './readiness';
import { usePublishUrl } from './usePublishUrl';
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
  chequebook = null,
  stampHealth,
  indented = false,
}: {
  profile: Profile;
  /** An ABR pool member leads its sub-line with the rung it publishes. */
  rung?: string | null;
  /**
   * What this deployment's Bee node last said about its chequebook, taken once
   * for the whole page. It is the only funding reading a row has, because no
   * list asks a node for its wallet.
   */
  chequebook?: ChequebookHealth | null;
  /**
   * What the page holds about this member's batch: the manager's pool assembly
   * where a pool result covers it, else the page's own poll of the node.
   * Undefined where neither answered, which is a reading this row does not have
   * rather than a batch that is not paying.
   */
  stampHealth?: StampHealth;
  indented?: boolean;
}) {
  const serverHost = useServerHost();
  const actions = useActions();
  const { openWizard, openEditDeployment } = useEditors();
  const publish = usePublishUrl(profile);

  const readiness = readinessOf(profile, stampHealth, chequebook);
  const shape = shapeOf(profile);
  const watchUrl = clientUrl(profile, serverHost);
  // The passphrase is asked for by the copy rather than by the row, so a page
  // of rows renders without asking for any deployment's.
  const copyable = publish.url !== null && readiness.tone === 'ok';

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
        void publish.copy();
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
            <Button size="small" onClick={() => void publish.copy()}>
              Copy publish URL
            </Button>
          )}
          {watchUrl && isRunning(profile) && (
            <Link href={watchUrl} target="_blank" rel="noopener noreferrer" variant="body2">
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
