import { Box, Button, Link, Stack, Typography } from '@mui/material';

import { useEditors } from '../app/EditorsContext';
import { routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { useActions } from '../app/useDeploymentActions';
import { ReadinessPill } from '../components/ReadinessPill';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ServiceChip } from '../components/ServiceChip';
import { ShapePill } from '../components/ShapePill';
import { formatDate } from '../format';
import type { DeploymentGroup, Profile } from '../types';
import { hostFor } from '../urls';
import { PrimaryAction } from './PrimaryAction';
import { isRunning, servicesOf, SHAPE_LABEL, shapeOf, statusLabelOf } from './shape';

export function DeploymentHeader({
  profile,
  serverHost,
  group,
  rung,
  publishUrl,
  publishUrlReady,
}: {
  profile: Profile;
  serverHost: string;
  group: DeploymentGroup | null;
  rung: string | null;
  publishUrl: string | null;
  publishUrlReady: boolean;
}) {
  const actions = useActions();
  const { openWizard, openEditDeployment } = useEditors();
  const shape = shapeOf(profile);
  const status = statusLabelOf(profile);

  const menuItems: RowMenuItem[] = [
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
  if (publishUrl && publishUrlReady) {
    menuItems.push({
      label: 'Copy publish URL',
      onSelect: () => {
        void navigator.clipboard.writeText(publishUrl).catch(() => undefined);
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
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ sm: 'flex-start' }}
      sx={{ pt: 1.5, pb: 2.25 }}
    >
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
          <Link href={routes.deployments}>Deployments</Link>
          {group && (
            <>
              {' / '}
              <Link href={routes.group(group.id)}>{group.name}</Link>
            </>
          )}
        </Typography>
        <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="h1" sx={{ fontFamily: MONO_STACK }}>
            {profile.name}
          </Typography>
          <ShapePill
            label={SHAPE_LABEL[shape] + (rung ? ` · ${rung}` : '')}
          />
          <ReadinessPill label={status.label} tone={status.tone} />
        </Stack>
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mt: 0.75 }}
        >
          <Typography variant="caption" color="text.secondary">
            {hostFor(profile, serverHost)} · slot {profile.port_slot} · created{' '}
            {formatDate(profile.created_at)}
          </Typography>
          {servicesOf(profile).map((service) => (
            <ServiceChip key={service} service={service} />
          ))}
        </Stack>
      </Box>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 'none' }}>
        <PrimaryAction profile={profile} size="medium" />
        <Button onClick={() => openEditDeployment(profile.name)}>Edit</Button>
        <RowMenu items={menuItems} ariaLabel={`more actions for ${profile.name}`} />
      </Stack>
    </Stack>
  );
}
