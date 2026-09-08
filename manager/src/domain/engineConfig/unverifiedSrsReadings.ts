import type { EngineSettingField, EngineSettingReadings } from '@streaming-infra-manager/common';

/** Temporary until the T11 SRS scalar reader lands. Token presence alone cannot prove custom directives. */
export function unverifiedSrsReadings(fields: readonly EngineSettingField[]): EngineSettingReadings {
  return Object.fromEntries(fields.map(field => [field.key, [{ kind: 'unverified', reason: 'unsupported-syntax' }]]));
}
