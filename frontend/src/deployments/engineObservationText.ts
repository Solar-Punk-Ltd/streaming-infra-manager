import type {
  EngineSettingBuiltInReason, EngineSettingObservation, EngineSettingUnknownReason,
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

