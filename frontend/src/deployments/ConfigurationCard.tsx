import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

import {
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  type ConfiguredBeeRpcEndpoint,
  configuredBeeRpcEndpoint,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  effectiveNodeMode,
  MANAGER_RPC_ENDPOINT_SOURCE,
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
import { fetchSrtPassphrase } from '../data';
import { beeApiUrl, hostFor } from '../urls';
import { nodeModeLabel, rpcEndpointLabel } from './nodeText';
import { isStreamLike } from './readiness';
import {
  endpointSourceOf,
  hasService,
  ownsAnyBeeNode,
  servicesOf,
  SHAPE_LABEL,
  shapeOf,
} from './shape';

const HIDDEN = '••••••••';

export function ConfigurationCard({
  profile,
  serverHost,
  hostPassphrase,
  beeRpcEndpoint,
  streamerName,
  stampHealth,
}: {
  profile: Profile;
  serverHost: string;
  /** The host-wide SRT passphrase, or null when the host has none. */
  hostPassphrase: string | null;
  /** The chain endpoint this manager offers, for the deployments that take it. */
  beeRpcEndpoint: ConfiguredBeeRpcEndpoint;
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
    entries.push({
      key: 'SRT passphrase',
      value: profile.has_srt_passphrase ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Mono>{HIDDEN}</Mono>
          <span>own passphrase</span>
          {/* Asked for on the click. The card is told one is stored, never which. */}
          <CopyButton
            value={() => fetchSrtPassphrase(profile.name)}
            label="SRT passphrase"
          />
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
        <span>own node · <Mono>{api ?? 'address unavailable'}</Mono></span>
      ) : (
        <span>external · <Mono>{profile.bee_url || 'the deploy default'}</Mono></span>
      ),
    });
  }

  if (ownsAnyBeeNode(profile)) {
    const mode = effectiveNodeMode(profile);
    entries.push({ key: 'Node mode', value: <Fixed>{nodeModeLabel(mode)}</Fixed> });
    entries.push({
      key: 'RPC endpoint',
      value: rpcEndpointLabel({
        mode,
        source: endpointSourceOf(profile),
        host: endpointHost(profile, beeRpcEndpoint),
      }),
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

/**
 * The host of the endpoint this node reads, which is all that is ever shown of
 * it: an endpoint URL can carry an API key in its path or its user info, and
 * this page is one anybody signed in can open.
 */
function endpointHost(
  profile: Profile,
  beeRpcEndpoint: ConfiguredBeeRpcEndpoint,
): string | null {
  const source = endpointSourceOf(profile);
  if (source === CUSTOM_RPC_ENDPOINT_SOURCE) {
    return profile.rpc_endpoint_host ?? null;
  }
  return source === MANAGER_RPC_ENDPOINT_SOURCE ? beeRpcEndpoint.host : null;
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
