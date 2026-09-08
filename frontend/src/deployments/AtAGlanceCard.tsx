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
import { formatDate, formatTtl } from '../format';
import type { DeploymentGroup, Profile } from '../types';
import { hostFor } from '../urls';
import { describeVersion } from '../versions/versionText';
import type { EngineOverview } from './engineApi';
import { ENGINE_LABEL, engineSummary } from './engineText';
import type { Readiness } from './readiness';
import { engineOf } from './shape';

export function AtAGlanceCard({
  profile,
  serverHost,
  readiness,
  stampHealth,
  group,
  version,
  engineOverview,
  engineLoadError,
}: {
  profile: Profile;
  serverHost: string;
  readiness: Readiness;
  stampHealth: StampHealth;
  group: DeploymentGroup | null;
  /** The stack version this deployment runs, or null until the list arrives. */
  version: StackVersion | null;
  /** The manager's answer about the engine, null until it arrives or when there is no engine. */
  engineOverview: EngineOverview | null;
  /** Why it did not arrive, or null. */
  engineLoadError: string | null;
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
      value: engineOverview
        ? engineSummary(engine, engineOverview.observations)
        : engineLoadError
          ? `${ENGINE_LABEL[engine]} · settings could not be loaded`
          : ENGINE_LABEL[engine],
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
