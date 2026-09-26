import type { StackSettingField } from './deploymentSettings.js';

/**
 * What the stack accepts for the settings whose shape a page can check before
 * a save. The bounds are the stream uploader's own, from its config reader
 * (`packages/stream-uploader/src/utils/config.ts` in swarm-hls-stream), and the
 * choices are the values the stack's samples name.
 *
 * A key missing here is plain text, and the container checks it when it
 * starts, as it does every stack setting. So a key belongs here only when its
 * rule is certain: a wrong bound refuses a value the stack takes. The two log
 * keys refuse values the uploader would take, and are here because it takes
 * them by ignoring them, so a typo there would change nothing and say nothing.
 */
export const STACK_SETTING_FIELDS: Readonly<Record<string, StackSettingField>> = {
  UPLOADER_START_GATES: { kind: 'choice', choices: ['chequebook-warn', 'warn', 'refuse'] },
  START_GATE_TIMEOUT_MS: { kind: 'integer', min: 1, max: 600_000 },
  CHEQUEBOOK_MIN_BZZ: { kind: 'number', min: 0, max: 1000 },
  CHEQUEBOOK_RECHECK_MS: { kind: 'integer', min: 1_000, max: 3_600_000 },
  STAMP_MIN_TTL_HOURS: { kind: 'number', min: 0, max: 8760 },
  STAMP_MAX_UTILIZATION: { kind: 'number', min: 0, max: 1 },
  BEE_REQUEST_TIMEOUT_MS: { kind: 'integer', min: 1 },
  MAX_QUEUE_SIZE: { kind: 'integer', min: 1 },
  SEGMENT_REDUNDANCY: { kind: 'integer', min: 0 },
  LOG_LEVEL: { kind: 'choice', choices: ['debug', 'log', 'info', 'warn', 'error', 'silent'] },
  LOG_FORMAT: { kind: 'choice', choices: ['', 'json'] },
  STAMP_IMMUTABLE: { kind: 'boolean' },
  BEE_UPLOADER_FULL_NODE: { kind: 'boolean' },
  BEE_RUNG_FULL_NODE: { kind: 'boolean' },
  BEE_GATEWAY_CACHE_RETRIEVAL: { kind: 'boolean' },
  OME_ADMISSION_FAIL_OPEN: { kind: 'boolean' },
};

const INTEGER_RE = /^-?\d+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const BOOLEAN_VALUES: readonly string[] = ['true', 'false'];

/** The field a key has, or null for plain text. */
export function stackSettingFieldOf(key: string): StackSettingField | null {
  return STACK_SETTING_FIELDS[key] ?? null;
}

/**
 * What is wrong with this value for this key, or null. An empty value is
 * always taken, because it leaves the key to the stack's own default. The
 * message reads on its own, key first, and repeats the value, which is safe
 * because no secret has a field.
 */
export function stackSettingFieldProblem(key: string, value: string): string | null {
  const field = STACK_SETTING_FIELDS[key];
  if (!field || value === '') return null;

  if (field.kind === 'choice') {
    const choices = field.choices ?? [];
    return choices.includes(value) ? null : `${key} must be one of ${choices.filter(Boolean).join(', ')}. Got "${value}".`;
  }
  if (field.kind === 'boolean') {
    return BOOLEAN_VALUES.includes(value) ? null : `${key} must be true or false. Got "${value}".`;
  }
  if (field.kind === 'text') return null;

  const shape = field.kind === 'integer' ? INTEGER_RE : NUMBER_RE;
  if (!shape.test(value)) {
    return field.kind === 'integer'
      ? `${key} must be a whole number. Got "${value}".`
      : `${key} must be a number, use a period for decimals. Got "${value}".`;
  }
  const parsed = Number(value);
  if (field.min !== undefined && parsed < field.min) return `${key} must be at least ${field.min}. Got ${value}.`;
  if (field.max !== undefined && parsed > field.max) return `${key} must be at most ${field.max}. Got ${value}.`;
  return null;
}
