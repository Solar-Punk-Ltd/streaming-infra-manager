import { ADMIN_API_TOKEN_KEY, ADMIN_API_TOKEN_MIN_LENGTH, ADMIN_API_URL_KEY } from './adminLink.js';
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
 * them by ignoring them: a mistyped level falls back to the default with one
 * line in the uploader's log, and a mistyped format falls back to text
 * without a word. The web2 admin address refuses a user name and a # part the
 * uploader would take, because it builds every request by adding a path after
 * the address, and either one then sends the request somewhere else.
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
  [ADMIN_API_URL_KEY]: { kind: 'url' },
  [ADMIN_API_TOKEN_KEY]: { kind: 'text', minLength: ADMIN_API_TOKEN_MIN_LENGTH },
};

const INTEGER_RE = /^-?\d+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const BOOLEAN_VALUES: readonly string[] = ['true', 'false'];
const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** The field a key has, or null for plain text. */
export function stackSettingFieldOf(key: string): StackSettingField | null {
  return STACK_SETTING_FIELDS[key] ?? null;
}

/** Why this is not an http or https address the stack can add its paths to, or null. Never repeats the address. */
function urlProblem(key: string, value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${key} must be an http or https address, such as https://admin.example.com.`;
  }
  if (!WEB_PROTOCOLS.includes(parsed.protocol) || parsed.hostname === '') {
    return `${key} must be an http or https address, such as https://admin.example.com.`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `${key} cannot carry a user name or a password.`;
  }
  // The raw text rather than `hash`, which is empty for a bare trailing #.
  if (value.includes('#')) return `${key} cannot carry a # part, because the stack adds its own paths after the address.`;
  return null;
}

/**
 * What is wrong with this value for this key, or null. An empty value is
 * always taken, because it leaves the key to the stack's own default. The
 * message reads on its own, key first. It repeats the value only for a list, a
 * switch or a number, whose keys are never secret, and never an address or a
 * text, because an address can carry a password and a text field can be a
 * token.
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
  if (field.kind === 'url') return urlProblem(key, value);
  if (field.kind === 'text') {
    return field.minLength !== undefined && value.length < field.minLength
      ? `${key} must be at least ${field.minLength} characters.`
      : null;
  }

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
