import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

import {
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  parseBeePublishers,
  SRS_SERVICE,
  type StampHealth,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { useEditors } from '../app/EditorsContext';
import { MONO_STACK } from '../app/theme';
import { CopyButton } from '../CopyButton';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { SectionCard } from '../components/SectionCard';
import { ServiceChip } from '../components/ServiceChip';
import { shortHex } from '../format';
import type { Profile } from '../types';
import { beeApiUrl, hostFor } from '../urls';
import { isStreamLike } from './readiness';
import { hasService, servicesOf, SHAPE_LABEL, shapeOf } from './shape';

const HIDDEN = '••••••••';

export function ConfigurationCard({
  profile,
  serverHost,
  hostPassphrase,
  streamerName,
  stampHealth,
}: {
  profile: Profile;
  serverHost: string;
  /** The host-wide SRT passphrase, or null when the host has none. */
  hostPassphrase: string | null;
  streamerName: string | null;
  stampHealth: StampHealth;
}) {
  const { openEditDeployment } = useEditors();
  const shape = shapeOf(profile);
  const entries: KeyValueEntry[] = [
    { key: 'Type', value: <Fixed>{SHAPE_LABEL[shape]}</Fixed> },
    {
      key: 'Components',
      value: (
        <Fixed>
          <Stack direction="row" spacing={0.5} sx={{ display: 'inline-flex', mr: 1 }}>
            {servicesOf(profile).map((service) => (
              <ServiceChip key={service} service={service} />
            ))}
          </Stack>
        </Fixed>
      ),
    },
    {
      key: 'Host',
      value: <Fixed><Mono>{hostFor(profile, serverHost)}</Mono></Fixed>,
    },
  ];

  if (hasService(profile, SRS_SERVICE)) {
    const own = profile.srt_passphrase?.trim();
    entries.push({
      key: 'SRT passphrase',
      value: own ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Mono>{HIDDEN}</Mono>
          <span>own passphrase</span>
          <CopyButton value={own} label="SRT passphrase" />
        </Stack>
      ) : hostPassphrase ? (
        <span>host-wide passphrase (default)</span>
      ) : (
        <Muted>none, and the host has no shared one, so the ingest is unencrypted</Muted>
      ),
    });
  }

  if (hasService(profile, STREAM_UPLOADER_SERVICE)) {
    entries.push({
      key: 'Stream key',
      value: profile.public_key ? (
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
          <Mono>{HIDDEN}</Mono>
          <span>address</span>
          <Mono>{shortHex(profile.public_key)}</Mono>
          <CopyButton value={profile.public_key} label="stream address" />
        </Stack>
      ) : (
        <Muted>none</Muted>
      ),
    });
  }

  if (isStreamLike(profile, shape)) {
    const api = beeApiUrl(profile, serverHost);
    entries.push({
      key: 'Bee node',
      value: hasService(profile, BEE_UPLOADER_SERVICE) ? (
        <span>own node · <Mono>{api ?? 'not running'}</Mono></span>
      ) : (
        <span>external · <Mono>{profile.bee_url || 'the deploy default'}</Mono></span>
      ),
    });
  }

  if (isStreamLike(profile, shape) || shape === 'bee-node') {
    entries.push({
      key: 'Postage stamp',
      value: profile.stamp_id ? (
        <span>
          <Mono>{shortHex(profile.stamp_id)}</Mono> · {stampHealth.state}
        </span>
      ) : (
        <Muted>none yet</Muted>
      ),
    });
  }

  if (shape === 'abr-uploader') {
    const rungs = parseBeePublishers(profile.bee_publishers ?? '') ?? [];
    entries.push({
      key: 'Node pool',
      value: rungs.length ? (
        <span>
          {rungs.length} rungs · <Mono>{rungs[0].url}</Mono> and the rest
        </span>
      ) : (
        <Muted>not set, so the uploader will not start</Muted>
      ),
    });
  }

  if (hasService(profile, CLIENT_SERVICE)) {
    entries.push({
      key: 'Follows streamer',
      value: profile.feed_owner ? (
        <span>
          <Mono>{shortHex(profile.feed_owner)}</Mono>
          {streamerName ? ` (${streamerName})` : ''}
        </span>
      ) : (
        <Muted>none</Muted>
      ),
    });
  }

  return (
    <SectionCard
      title="Configuration"
      actions={
        <Button size="small" onClick={() => openEditDeployment(profile.name)}>
          Edit
        </Button>
      }
    >
      <KeyValueList entries={entries} />
    </SectionCard>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ fontFamily: MONO_STACK }}>
      {children}
    </Box>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <Typography component="span" variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}

function Fixed({ children }: { children: ReactNode }) {
  return (
    <>
      {children}{' '}
      <Typography component="span" variant="caption" color="text.secondary">
        (fixed)
      </Typography>
    </>
  );
}
