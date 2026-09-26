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
 * Bounds and help text come from the stack (`engines/srs/.env.sample`,
 * `engines/ome/.env.sample` and both `entrypoint.sh` files). A field's
 * `defaultValue` is not the pinned stack's number and is not meant to track
 * it: a version's contract names what that version's entrypoints fall back to
 * and wins over the field, so `defaultValue` answers only where no contract
 * was read, such as the offline mock and a version whose checkout could not be
 * parsed. A field whose default the manager owns is the exception, see
 * `managerOwnsDefault`. A later stack version reads more keys than this, and
 * fewer of them, which is why the settings are stored as one JSONB column
 * rather than as a column each.
 */
import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import type { EngineDefaults } from './engineDefaults.js';
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
  /**
   * What applies when nothing is stored and no contract was read: the
   * manager's own number, not the stack's, as the header says. Always a
   * string, as env is.
   */
  defaultValue: string;
  /**
   * `defaultValue` applies on every stack version in place of the version's
   * own fallback, and `engineSettingsEnv` writes it wherever the host sets no
   * value of its own. For a number the owner decided after the versions in use
   * were cut: they still fall back to the old one, so a default the manager
   * only named would describe a container nobody runs.
   */
  managerOwnsDefault?: boolean;
  min?: number;
  max?: number;
  choices?: readonly string[];
  help: string;
  /** Read only when the ABR ladder is on, which is the abr-uploader kind. */
  abrOnly: boolean;
  /**
   * The token in the engine's config template that this value fills at
   * container start. Absent for a setting the config never carries, which the
   * uploader reads instead. A custom config file that drops the token stops
   * reading the setting, see `settingsNotInConfig`.
   */
  placeholder?: string;
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
    // The manager's own default segment length is two seconds, by the owner's
    // decision of 2026-09-16, rather than anything a stack version cuts.
    defaultValue: '2',
    min: 0.5,
    max: 30,
    help: 'The shortest a piece of the stream may be. The engine cuts on a keyframe, so the piece you actually get is the first keyframe at or after this, which means the interval the publisher sends decides the real length and this only puts a floor under it. Set your publisher to the length you want, and leave this at or below it.',
    abrOnly: false,
    placeholder: 'HLS_FRAGMENT_PLACEHOLDER',
  },
  {
    key: 'HLS_SEGMENT_MAX',
    label: 'Force-close a piece after',
    unit: 'seconds',
    kind: 'number',
    defaultValue: '2.5',
    min: 0.5,
    max: 30,
    help: 'The longest a piece may run before the engine cuts it without waiting for a keyframe. Keep it above both the segment length and the keyframe interval your publisher sends, with a little room, because a piece overruns its settled length by about 0.135 seconds. A piece cut off a keyframe cannot be decoded on its own, which breaks seeking and quality switching, so this is a last resort rather than a target.',
    abrOnly: false,
    // The config carries the engine's own knob, a multiple of the fragment,
    // which the stack entrypoint derives from this. Named here so a custom
    // config file that drops the token is reported as no longer reading it.
    placeholder: 'HLS_AOF_RATIO_PLACEHOLDER',
  },
  {
    key: 'HLS_WINDOW',
    label: 'Playlist window',
    unit: 'seconds',
    kind: 'number',
    // The window follows the stack, whose compose keeps fifteen seconds.
    defaultValue: '15',
    min: 1,
    max: 600,
    help: 'How much of the stream the playlist keeps. It is a duration and not a count, so raising the segment length on its own leaves fewer pieces in the playlist. Move the two together. The player aims about 10 seconds behind live and that has to stay comfortably inside this.',
    abrOnly: false,
    placeholder: 'HLS_WINDOW_PLACEHOLDER',
  },
  {
    key: 'SRT_LATENCY',
    label: 'SRT latency',
    unit: 'milliseconds',
    kind: 'integer',
    // The owner's decision of 2026-09-23. An outside broadcaster lost 5 to 8.5%
    // of its packets on 2026-09-22, and SRS dropped nearly every resend as too
    // late at its own 120, where the stack asked for 200 and SRS ignored it.
    defaultValue: '2000',
    managerOwnsDefault: true,
    // The entrypoint refuses only a value that is not a number, so these bounds
    // are the manager's. Under 20 leaves no time for a resend even across a
    // local network. 10000 is about what SRS's default receive buffer of 8192
    // packets holds of an 8 Mbps broadcast in 1316 byte packets, 10.8 seconds
    // by arithmetic, and a longer wait overflows that buffer rather than
    // recovering a packet.
    min: 20,
    max: 10_000,
    help: 'How long SRS waits for a lost packet to be resent before giving up on it. A higher value tolerates a worse broadcaster connection and adds the same amount of delay to the stream. 2000 suits broadcasters sending over the open internet.',
    abrOnly: false,
    placeholder: 'SRT_LATENCY_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'TRANSCODE_PLACEHOLDER',
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
    placeholder: 'SEGMENT_DURATION_PLACEHOLDER',
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
    placeholder: 'SEGMENT_COUNT_PLACEHOLDER',
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

/** The engine that reads each key, which no two engines share. */
const ENGINE_OF_KEY: ReadonlyMap<string, EngineName> = new Map([
  ...SRS_SETTINGS.map((field) => [field.key, SRS_SERVICE] as const),
  ...OME_SETTINGS.map((field) => [field.key, OME_SERVICE] as const),
]);

/** The engine that reads this key as one of its settings, or null for a key no engine setting takes. */
export function engineOfSettingKey(key: string): EngineName | null {
  return ENGINE_OF_KEY.get(key) ?? null;
}

/** The field this key names among either engine's settings, or null. */
export function engineSettingFieldOf(key: string): EngineSettingField | null {
  const engine = engineOfSettingKey(key);
  return engine === null ? null : (engineSettingsFields(engine).find((field) => field.key === key) ?? null);
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

/**
 * What the engine actually runs with: what is stored, else the default.
 *
 * `defaults` is what an unset field falls back to on the host this deployment
 * runs on, which `effectiveEngineDefaults` answers. Left out, every field falls
 * back to its own `defaultValue`, the manager's number rather than the stack's.
 * `omitted` names the keys a config file of the
 * deployment's own no longer reads: nothing in that file takes the value, so
 * what the engine runs with for them is not known from here, and they are
 * left out rather than guessed.
 */
export function effectiveEngineSettings(
  engine: EngineName,
  settings: EngineSettings,
  defaults: EngineSettings = {},
  omitted: readonly string[] = [],
): EngineSettings {
  const effective: EngineSettings = {};
  for (const field of engineSettingsFields(engine)) {
    if (omitted.includes(field.key)) continue;
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
 * Exported so the settings page can put the message under the input that
 * caused it. `engineSettingsProblem` is still the gate, because the keyframe
 * rule spans two fields and no single input owns it. An empty value names no
 * default, because the field's own number is not what an unset key falls back
 * to on a host that sets one.
 */
export function engineSettingFieldProblem(
  field: EngineSettingField,
  rawValue: string,
): string | null {
  const value = rawValue.trim();
  if (!value) {
    return `${field.label} cannot be empty. Leave it unset to use the default instead.`;
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

/**
 * The engine force-closes a piece it has run past without a keyframe, so a
 * ceiling under the segment length cuts every piece before one can end it. The
 * SRS entrypoint exits 1 on that pair rather than starting, and compose
 * supplies 2.5 whenever the profile sets no ceiling of its own, which is why an
 * unset ceiling is checked at what the host falls back to.
 */
function forceCloseCeilingProblem(
  settings: EngineSettings,
  defaults: EngineSettings,
): string | null {
  const effective = effectiveEngineSettings(SRS_SERVICE, settings, defaults);
  const fragment = effective.HLS_FRAGMENT ?? '';
  const ceiling = effective.HLS_SEGMENT_MAX ?? '';
  if (!NUMBER_RE.test(fragment) || !NUMBER_RE.test(ceiling)) return null;
  if (Number(ceiling) >= Number(fragment)) return null;

  return (
    `The force-close ceiling of ${ceiling} seconds is below the segment length of ${fragment} seconds, ` +
    'so every piece would be cut before a keyframe could end one and the engine refuses to start. ' +
    'Raise the ceiling to at least the segment length, or lower the segment length.'
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
   * `effectiveEngineDefaults`. Each cross-field rule spans two fields and either
   * of them may be unset, so checking one against the field defaults passes a
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

  if (engine === SRS_SERVICE) {
    const defaults = options.defaults ?? {};
    const ceiling = forceCloseCeilingProblem(settings, defaults);
    if (ceiling) return ceiling;
    if (options.abr) return gopProblem(settings, defaults);
  }
  return null;
}

export interface EngineSettingsEnvOptions {
  abr: boolean;
  /**
   * What each unset key falls back to on the host this deployment runs on,
   * from `effectiveEngineDefaults`. A default whose source is the manager is
   * written, and nothing else from it. Left out, only stored keys are.
   */
  defaults?: EngineDefaults;
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
 *
 * The one exception is a default the manager owns, written wherever the host
 * sets no value of its own. Left out, the container would start on the
 * version's own fallback, a different number from the one the drawer names.
 */
export function engineSettingsEnv(
  engine: EngineName,
  settings: EngineSettings,
  options: EngineSettingsEnvOptions = { abr: false },
): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const field of engineSettingsFieldsFor(engine, options)) {
    const value =
      settings[field.key]?.trim() || managerDefaultOf(field, options.defaults);
    if (value) pairs[field.key] = value;
  }
  return pairs;
}

function managerDefaultOf(
  field: EngineSettingField,
  defaults: EngineDefaults | undefined,
): string | undefined {
  return defaults?.sources[field.key] === 'manager'
    ? defaults.values[field.key]
    : undefined;
}
