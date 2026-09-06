import type { ReactNode } from 'react';
import { Box, Link } from '@mui/material';

import type {
  StackVersion,
  StampHealth,
} from '@streaming-infra-manager/common';

import { routes } from '../app/router';
import { MONO_STACK } from '../app/theme';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import { formatDate, formatTtl, shortCommit } from '../format';
import type { DeploymentGroup, Profile } from '../types';
import { hostFor } from '../urls';
import { engineSummary } from './engineText';
import type { Readiness } from './readiness';
import { engineOf } from './shape';

const COMMIT_UNKNOWN = 'commit unknown on this host';

/**
 * `bundled @ ee99c36`, or the name alone when the host cannot name a commit.
 *
 * A commit is unknown when the checkout arrived without a .git and without the
 * file deploy.sh writes next to it, which is a real state and not an error.
 */
function describeVersion(version: StackVersion): string {
  return version.commitSha
    ? `${version.name} @ ${shortCommit(version.commitSha)}`
    : `${version.name}, ${COMMIT_UNKNOWN}`;
}

export function AtAGlanceCard({
  profile,
  serverHost,
  readiness,
  stampHealth,
  group,
  version,
}: {
  profile: Profile;
  serverHost: string;
  readiness: Readiness;
  stampHealth: StampHealth;
  group: DeploymentGroup | null;
  /** The stack version this deployment runs, or null until the list arrives. */
  version: StackVersion | null;
}) {
  const engine = engineOf(profile);
  const entries: KeyValueEntry[] = [
    {
      key: 'State',
      value: <ReadinessPill label={readiness.label} tone={readiness.tone} />,
    },
    { key: 'Host', value: <Mono>{hostFor(profile, serverHost)}</Mono> },
    { key: 'Slot', value: <Mono>{profile.port_slot}</Mono> },
  ];

  if (engine) {
    entries.push({
      key: 'Engine',
      value: engineSummary(engine, profile.engine_settings),
    });
  }

  if (version) {
    entries.push({
      key: 'Version',
      value: <Mono>{describeVersion(version)}</Mono>,
    });
  }

  if (profile.stamp_id) {
    entries.push({
      key: 'Stamp',
      value:
        stampHealth.state === 'active'
          ? `${formatTtl(stampHealth.ttl)} left`
          : stampHealth.state,
    });
  }

  if (group) {
    entries.push({
      key: 'Group',
      value: (
        <Link href={routes.group(group.id)} sx={{ fontFamily: MONO_STACK }}>
          {group.name}
        </Link>
      ),
    });
  }

  entries.push({ key: 'Created', value: formatDate(profile.created_at) });

  return (
    <SectionCard title="At a glance">
      <KeyValueList entries={entries} labelWidth={90} />
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
