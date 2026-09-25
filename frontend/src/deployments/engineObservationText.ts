import type {
  EngineDefaultSource, EngineSettingBuiltInReason, EngineSettingObservation, EngineSettingUnknownReason,
} from '@streaming-infra-manager/common';

export interface EngineObservationText {
  value: string;
  source: string;
  detail: string;
}

const SOURCES = {
  deployment: 'Deployment override', host: 'Host default', manager: 'Manager default', stack: 'Stack default',
  'config-file': 'Set in config file', 'built-in': 'Engine default',
} as const;

const BUILT_IN_DETAILS: Record<EngineSettingBuiltInReason, string> = {
  'latency-without-recvlatency': 'SRS ignores latency for ingest without recvlatency. This config sets latency and no recvlatency, so SRS waits its own default instead.',
  'no-recvlatency': 'This config sets no recvlatency, which is what SRS reads for this wait on ingest, so SRS waits its own default.',
  'version-without-recvlatency': "SRS ignores latency for ingest without recvlatency. This stack version's template sets latency and no recvlatency, so SRS waits its own default instead.",
  'version-without-setting': "This stack version does not read this setting. Its template decides the wait on ingest: the recvlatency it sets, or SRS's own default where it sets none.",
};

const VERSION_REASONS: readonly EngineSettingBuiltInReason[] = ['version-without-recvlatency', 'version-without-setting'];

/**
 * A value the deployment's stack version decides, because it runs the
 * version's template and that template leaves the setting out. No config file
 * of the deployment's own is involved, so the config file wording would send
 * an operator looking for a file that is not there.
 */
function decidedByVersion(observation: EngineSettingObservation | undefined): boolean {
  return observation?.status === 'known' && observation.source === 'built-in'
    && VERSION_REASONS.includes(observation.reason);
}

/**
 * What an empty field falls back to, and where that value comes from.
 *
 * A host whose base `.env` already sets the key runs that value, because
 * `.env.<profile>` is a copy of it and an unset key is left out. Naming the
 * stack's own number there would describe a container nobody is running. A
 * default the manager owns is the manager's, whatever the version falls back to.
 */
export function engineDefaultText(value: string, source: EngineDefaultSource, unit: string): string {
  switch (source) {
    case 'host': return `Default ${value}${unit}, set on this host`;
    case 'manager': return `Manager default ${value}${unit}`;
    case 'stack': return `Stack default ${value}${unit}`;
  }
}

const UNKNOWN_DETAILS: Record<EngineSettingUnknownReason, string> = {
  'missing-directive': 'At least one relevant section of the config omits this setting. Its engine default has not been observed.',
  'conflicting-values': 'Relevant sections of the config contain different values for this setting.',
  'mixed-sources': 'Some relevant sections use an override and others set a value directly in the config file.',
  'ambiguous-path': 'Repeated or ambiguous config sections prevent one reliable reading.',
  'unsupported-syntax': 'The config uses syntax the manager cannot verify for this setting.',
  'invalid-scalar': 'The config contains a value the manager cannot validate for this setting.',
  'metadata-unavailable': 'The config or its version template is unavailable.',
  'not-applicable': 'All relevant encoders copy audio, so this setting does not apply.',
  'mixed-applicability': 'Some encoders copy audio and others encode it, so one value cannot describe them.',
  'codec-unverified': 'The audio codec is not confirmed as AAC or copy, so bitrate applicability is unverified.',
};

/** Values and source labels come from the same server observation. */
export function engineObservationText(observation: EngineSettingObservation | undefined, unit = ''): EngineObservationText {
  if (!observation) return { value: 'Unverified', source: 'Not observed', detail: 'No current observation is available for this setting.' };
  if (observation.status === 'known') {
    return {
      value: `${observation.value}${unit ? ` ${unit}` : ''}`,
      source: SOURCES[observation.source],
      detail: observation.source === 'built-in' ? BUILT_IN_DETAILS[observation.reason] : '',
    };
  }
  return {
    value: observation.reason === 'not-applicable' ? 'Not applicable' : observation.source === 'omitted' ? 'Not specified' : 'Unverified',
    source: observation.source === 'omitted' ? 'Omitted from config' : 'Not verified',
    detail: UNKNOWN_DETAILS[observation.reason],
  };
}

/** What the settings drawer says under a field about the value it observed, and why where there is a why. */
export function engineObservationNote(observation: EngineSettingObservation | undefined, unit = ''): string {
  const text = engineObservationText(observation, unit);
  if (observation?.status !== 'known') return `${text.value}. ${text.detail}`;
  return [`Configured value: ${text.value}.`, `${text.source}.`, text.detail].filter(Boolean).join(' ');
}

export function engineOverrideHint(observation: EngineSettingObservation | undefined): string {
  if (decidedByVersion(observation)) return 'Changing this setting will not change the wait on ingest on this stack version.';
  switch (observation?.environment) {
    case 'all': return 'This config reads the override in every relevant section.';
    case 'none': return 'Changing this override will not change this setting in the config file. Edit the config file to change it.';
    case 'partial': return 'Only some relevant sections read this override. Applying it may not change every section.';
    default: return 'Whether this config reads the override is unverified.';
  }
}

/** What an empty override field shows where no default it falls back to can be named. */
export function engineOverridePlaceholder(observation: EngineSettingObservation | undefined): string {
  if (decidedByVersion(observation)) return 'Stack version controls value';
  return observation?.environment === 'none' ? 'Config controls value' : 'Config use unverified';
}
