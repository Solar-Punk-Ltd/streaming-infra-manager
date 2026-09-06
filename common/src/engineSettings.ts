/**
 * The engine settings an operator may change per deployment, and the rules the
 * stack's entrypoint scripts apply to them.
 *
 * The manager, the settings drawer and the offline mock all read this list, so
 * a value the drawer accepts is a value the container starts with. The
 * alternative was three copies of the same bounds, and the failure that follows
 * from them drifting is a container that crash-loops under
 * `restart: unless-stopped` with the reason only in its logs.
 *
 * Defaults, bounds and help text come from the pinned stack
 * (`engines/srs/.env.sample`, `engines/ome/.env.sample` and both
 * `entrypoint.sh` files). A later stack version reads more keys than this, and
 * fewer of them, which is why the settings are stored as one JSONB column
 * rather than as a column each.
 */
import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import type { EngineName } from './engines.js';
import {
  ENV_SAFE_VALUE_MESSAGE,
  isEnvSafeValue,
} from './envSafeValue.js';

/**
 * `number` is any positive decimal, `integer` a whole one, `choice` a value from
 * a fixed list. They mirror the entrypoint's own `require_number`,
 * `require_int` and `require_name`.
 */
export type EngineSettingKind = 'number' | 'integer' | 'choice';

export interface EngineSettingField {
  key: string;
  label: string;
  /** Shown after the input. Null for a choice, which has no unit. */
  unit: string | null;
  kind: EngineSettingKind;
  /** The stack's own value when nothing is stored. Always a string, as env is. */
  defaultValue: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
  help: string;
  /** Read only when the ABR ladder is on, which is the abr-uploader kind. */
  abrOnly: boolean;
}

/**
 * What is stored on a profile: known keys of one engine, values as strings
 * because they end up as lines in an env file. An absent key means the stack's
 * own default applies.
 */
export type EngineSettings = Record<string, string>;

const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
] as const;

const H264_PROFILES = ['baseline', 'main', 'high'] as const;

const AUDIO_CODECS = ['copy', 'aac'] as const;

export const SRS_SETTINGS: readonly EngineSettingField[] = [
  {
    key: 'HLS_FRAGMENT',
    label: 'Segment length',
    unit: 'seconds',
    kind: 'number',
    defaultValue: '1.5',
    min: 0.5,
    max: 30,
    help: "How long each piece of the stream is. SRS can only cut on a keyframe, so keep the publisher's keyframe interval at or below this, otherwise the pieces come out longer than you asked for.",
    abrOnly: false,
  },
  {
    key: 'HLS_WINDOW',
    label: 'Playlist window',
    unit: 'seconds',
    kind: 'number',
    defaultValue: '22.5',
    min: 1,
    max: 600,
    help: 'How much of the stream the playlist keeps. It is a duration and not a count, so raising the segment length on its own leaves fewer pieces in the playlist. Move the two together. The player aims about 10 seconds behind live and that has to stay comfortably inside this.',
    abrOnly: false,
  },
  {
    key: 'ABR_FPS',
    label: 'Frame rate',
    unit: 'frames per second',
    kind: 'integer',
    defaultValue: '30',
    min: 1,
    max: 120,
    help: 'Frames per second every rung is encoded at. Frame rate times segment length has to be a whole number of frames, because that product is the keyframe interval and every rung has to place its keyframes at the same moments.',
    abrOnly: true,
  },
  {
    key: 'ABR_PRESET',
    label: 'Encoder preset',
    unit: null,
    kind: 'choice',
    defaultValue: 'veryfast',
    choices: X264_PRESETS,
    help: 'How hard the encoder works on each frame. A slower preset looks better and costs more CPU, and there is one encode per rung.',
    abrOnly: true,
  },
  {
    key: 'ABR_PROFILE',
    label: 'H.264 profile',
    unit: null,
    kind: 'choice',
    defaultValue: 'main',
    choices: H264_PROFILES,
    help: 'The H.264 feature set the rungs are encoded with. Main plays everywhere that matters. Baseline is for very old devices and costs quality at the same bitrate.',
    abrOnly: true,
  },
  {
    key: 'ABR_THREADS',
    label: 'Encoder threads',
    unit: 'per rung',
    kind: 'integer',
    defaultValue: '0',
    min: 0,
    max: 64,
    help: 'Threads for each rung, and 0 lets the encoder pick. There is one encoder process per rung and each decodes the source on its own, so four rungs is four decodes. That is usually the real CPU floor of the ladder.',
    abrOnly: true,
  },
  {
    key: 'ABR_ACODEC',
    label: 'Audio codec',
    unit: null,
    kind: 'choice',
    defaultValue: 'copy',
    choices: AUDIO_CODECS,
    help: "Copy passes the publisher's audio through unchanged on every rung, which costs no CPU and keeps the rungs in sync with each other. Switch to aac when the publisher sends something the players cannot take.",
    abrOnly: true,
  },
  {
    key: 'ABR_AUDIO_BITRATE',
    label: 'Audio bitrate',
    unit: 'kbps',
    kind: 'integer',
    defaultValue: '128',
    min: 8,
    max: 512,
    help: "Only used when the audio codec is aac. With copy the publisher's own audio is passed through and this has no effect.",
    abrOnly: true,
  },
  {
    key: 'ABR_VBV_SECONDS',
    label: 'Encoder buffer',
    unit: 'seconds',
    kind: 'integer',
    defaultValue: '1',
    min: 1,
    max: 10,
    help: "Seconds of buffer, as a multiple of each rung's bitrate. It turns the rung's bitrate from an average the encoder may overshoot into a ceiling. 1 is tight, which is what a live ladder wants, because a larger buffer lets a busy scene borrow bitrate from the next one and produces the size spikes that stall a viewer.",
    abrOnly: true,
  },
];

export const OME_SETTINGS: readonly EngineSettingField[] = [
  {
    key: 'HLS_SEGMENT_DURATION',
    label: 'Segment duration',
    unit: 'seconds',
    kind: 'number',
    defaultValue: '2',
    min: 0.5,
    max: 30,
    help: 'How long each piece of the stream is, for both the video and the audio application.',
    abrOnly: false,
  },
  {
    key: 'HLS_SEGMENT_COUNT',
    label: 'Segment count',
    unit: 'pieces',
    kind: 'integer',
    defaultValue: '5',
    min: 2,
    max: 30,
    help: 'How many pieces the playlist keeps. Duration times count is the playlist window, and the player aims about 10 seconds behind live, so keep the product comfortably above that. At the defaults the two are equal, which parks the playhead on the oldest piece.',
    abrOnly: false,
  },
  {
    key: 'OME_HLS_POLL_INTERVAL_MS',
    label: 'Poll interval',
    unit: 'milliseconds',
    kind: 'integer',
    defaultValue: '500',
    min: 50,
    max: 10_000,
    help: 'How often the uploader asks OvenMediaEngine whether a new piece is ready. The uploader reads this one, not the engine, so changing it recreates the uploader container as well as the engine.',
    abrOnly: false,
  },
];

export function engineSettingsFields(
  engine: EngineName,
): readonly EngineSettingField[] {
  return engine === OME_SERVICE ? OME_SETTINGS : SRS_SETTINGS;
}

/** The fields an operator may set, which for an ABR field means an ABR profile. */
export function engineSettingsFieldsFor(
  engine: EngineName,
  options: { abr: boolean },
): readonly EngineSettingField[] {
  return engineSettingsFields(engine).filter(
    (field) => options.abr || !field.abrOnly,
  );
}

/**
 * The stored keys this deployment still reads, and nothing else.
 *
 * A setting outlives the state it was set under. Turning the ABR ladder off
 * leaves the rung settings in the column, where they apply to nothing and no
 * drawer renders them. They are dropped here rather than refused, because a
 * refusal would fail every later deploy of that deployment over a value the
 * operator has no way to see, let alone remove.
 */
export function applicableEngineSettings(
  engine: EngineName,
  settings: EngineSettings,
  options: { abr: boolean },
): EngineSettings {
  const applicable: EngineSettings = {};
  for (const field of engineSettingsFieldsFor(engine, options)) {
    const value = settings[field.key];
    if (value !== undefined) applicable[field.key] = value;
  }
  return applicable;
}

/** Every field's stack default, for the drawer to show beside what is stored. */
export function engineSettingsDefaults(engine: EngineName): EngineSettings {
  const defaults: EngineSettings = {};
  for (const field of engineSettingsFields(engine)) {
    defaults[field.key] = field.defaultValue;
  }
  return defaults;
}

/**
 * What the engine actually runs with: what is stored, else the default.
 *
 * `defaults` is what an unset field falls back to on the host this deployment
 * runs on, which `effectiveEngineDefaults` answers. Left out, every field falls
 * back to the stack's own value.
 */
export function effectiveEngineSettings(
  engine: EngineName,
  settings: EngineSettings,
  defaults: EngineSettings = {},
): EngineSettings {
  const effective: EngineSettings = {};
  for (const field of engineSettingsFields(engine)) {
    const stored = settings[field.key]?.trim();
    effective[field.key] =
      stored || defaults[field.key] || field.defaultValue;
  }
  return effective;
}

const INTEGER_RE = /^\d+$/;

/**
 * Six fraction digits at most.
 *
 * The keyframe rule multiplies the segment length by the frame rate on integers
 * scaled by ten to the number of digits, so an unbounded fraction is an
 * unbounded scale factor. Nothing either engine reads is measured finer than a
 * microsecond anyway.
 */
const NUMBER_RE = /^\d+(\.\d{1,6})?$/;

/**
 * What is wrong with one field's value, or null.
 *
 * Exported so the settings drawer can put the message under the input that
 * caused it. `engineSettingsProblem` is still the gate, because the keyframe
 * rule spans two fields and no single input owns it.
 */
export function engineSettingFieldProblem(
  field: EngineSettingField,
  rawValue: string,
): string | null {
  const value = rawValue.trim();
  if (!value) {
    return `${field.label} cannot be empty. Clear the whole field to go back to the stack default of ${field.defaultValue}.`;
  }

  if (field.kind === 'choice') {
    const choices = field.choices ?? [];
    return choices.includes(value)
      ? null
      : `${field.label} must be one of ${choices.join(', ')}. Got "${value}".`;
  }

  // The shape before the character set. Both refuse `1,5`, and only one of them
  // tells an operator who typed a decimal comma what to type instead.
  const shape = field.kind === 'integer' ? INTEGER_RE : NUMBER_RE;
  if (!shape.test(value)) {
    return field.kind === 'integer'
      ? `${field.label} must be a whole number. Got "${value}".`
      : `${field.label} must be a positive number, use a period for decimals. Got ${value}.`;
  }

  // Nothing the shapes above admit can carry one of these, and the check stays
  // because the guarantee is relied on elsewhere: the entrypoint splices this
  // value into a `sed` expression as it stands.
  if (!isEnvSafeValue(value)) {
    return `${field.label} ${ENV_SAFE_VALUE_MESSAGE}, because the value is written into the engine's config file as it stands. Got "${rawValue}".`;
  }

  const parsed = Number(value);
  if (field.min !== undefined && parsed < field.min) {
    return `${field.label} must be at least ${field.min}. Got ${value}.`;
  }
  if (field.max !== undefined && parsed > field.max) {
    return `${field.label} must be at most ${field.max}. Got ${value}.`;
  }
  return null;
}

function decimalPlaces(value: string): number {
  const dot = value.indexOf('.');
  return dot < 0 ? 0 : value.length - dot - 1;
}

/**
 * Frames per second times seconds, computed on integers.
 *
 * `0.1 * 3` is not `0.3` in binary, and a keyframe rule that calls a pair the
 * container accepts "not whole" is worse than no rule at all.
 */
function framesPerSegment(fps: string, fragmentSeconds: string): number {
  const scale = 10 ** decimalPlaces(fragmentSeconds);
  const scaledFragment = Math.round(Number(fragmentSeconds) * scale);
  return (Number(fps) * scaledFragment) / scale;
}

function gopProblem(
  settings: EngineSettings,
  defaults: EngineSettings,
): string | null {
  const effective = effectiveEngineSettings(SRS_SERVICE, settings, defaults);
  const fps = effective.ABR_FPS ?? '';
  const fragment = effective.HLS_FRAGMENT ?? '';
  if (!INTEGER_RE.test(fps) || !NUMBER_RE.test(fragment)) return null;

  const frames = framesPerSegment(fps, fragment);
  if (Number.isInteger(frames)) return null;

  return (
    `Frame rate ${fps} times segment length ${fragment} is ${frames} frames, which is not a whole number. ` +
    'Pick values whose product is whole, otherwise the rungs cannot place their keyframes at the same moments and the engine refuses to start.'
  );
}

export interface EngineSettingsCheckOptions {
  /**
   * The ABR ladder is on for this profile, which decides both whether the ABR
   * fields may be set at all and whether the keyframe rule applies.
   */
  abr: boolean;
  /**
   * What an unset field falls back to on the host this deployment runs on, from
   * `effectiveEngineDefaults`. The keyframe rule spans two fields and either of
   * them may be unset, so checking it against the stack's own values passes a
   * pair the host then refuses, and refuses a pair it would have started with.
   */
  defaults?: EngineSettings;
}

/**
 * The first thing wrong with these settings, in words an operator can act on,
 * or null when the engine would start with them.
 */
export function engineSettingsProblem(
  engine: EngineName,
  settings: EngineSettings,
  options: EngineSettingsCheckOptions = { abr: false },
): string | null {
  const fields = engineSettingsFields(engine);
  const known = new Map(fields.map((field) => [field.key, field]));

  for (const key of Object.keys(settings)) {
    const field = known.get(key);
    if (!field) {
      return `${key} is not a setting the ${engine} engine reads. Remove it and try again.`;
    }
    if (field.abrOnly && !options.abr) {
      return `${field.label} only applies to a deployment that encodes the ABR ladder. Remove it and try again.`;
    }
  }

  for (const field of fields) {
    const value = settings[field.key];
    if (value === undefined) continue;
    const problem = engineSettingFieldProblem(field, value);
    if (problem) return problem;
  }

  if (engine === SRS_SERVICE && options.abr) {
    return gopProblem(settings, options.defaults ?? {});
  }
  return null;
}

/**
 * The lines to write into `.env.<profile>`, for the keys this profile actually
 * carries and still reads.
 *
 * A key that is not stored is left out on purpose: `.env.<profile>` is a fresh
 * copy of the stack's base `.env` on every deploy, so an absent key keeps
 * whatever the host was configured with, exactly as an unset SRT passphrase
 * does. Writing the defaults instead would silently override a value somebody
 * set on the box by hand. A key that no longer applies is left out for the
 * reason `applicableEngineSettings` gives.
 */
export function engineSettingsEnv(
  engine: EngineName,
  settings: EngineSettings,
  options: { abr: boolean } = { abr: false },
): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const field of engineSettingsFieldsFor(engine, options)) {
    const value = settings[field.key]?.trim();
    if (value) pairs[field.key] = value;
  }
  return pairs;
}
