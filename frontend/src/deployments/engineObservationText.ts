import type { EngineSettingObservation, EngineSettingUnknownReason } from '@streaming-infra-manager/common';

export interface EngineObservationText {
  value: string;
  source: string;
  detail: string;
}

const SOURCES = {
  deployment: 'Deployment override', host: 'Host default', stack: 'Stack default', 'config-file': 'Set in config file',
} as const;

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
    return { value: `${observation.value}${unit ? ` ${unit}` : ''}`, source: SOURCES[observation.source], detail: '' };
  }
  return {
    value: observation.reason === 'not-applicable' ? 'Not applicable' : observation.source === 'omitted' ? 'Not specified' : 'Unverified',
    source: observation.source === 'omitted' ? 'Omitted from config' : 'Not verified',
    detail: UNKNOWN_DETAILS[observation.reason],
  };
}

export function engineOverrideHint(observation: EngineSettingObservation | undefined): string {
  switch (observation?.environment) {
    case 'all': return 'This config reads the override in every relevant section.';
    case 'none': return 'Changing this override will not change this setting in the config file. Edit the config file to change it.';
    case 'partial': return 'Only some relevant sections read this override. Applying it may not change every section.';
    default: return 'Whether this config reads the override is unverified.';
  }
}
