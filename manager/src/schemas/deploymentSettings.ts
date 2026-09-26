import { array, mixed, number, object, string, InferType } from 'yup';

/** The shape of an env key, the same rule the version settings save holds a key to. */
const SETTINGS_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What one save may carry. The largest sample the stack has declares under two
 * hundred keys, so a save of every one of them fits, and the value bound is far
 * past any real setting while keeping one save a small request.
 */
const MAX_SAVE_ENTRIES = 512;
const MAX_VALUE_LENGTH = 8192;

const EXPECTED_INSTANCE_MESSAGE = 'expectedInstanceId must be a deployment instance UUID';

/**
 * yup's own message for a value of the wrong type repeats the value, and a
 * list of settings sent as a map or as `KEY=value` strings carries its secrets
 * in exactly that value.
 */
const ENTRIES_SHAPE_MESSAGE = 'entries is a list of settings, each a key and a value';
const ENTRY_SHAPE_MESSAGE = 'each entry of a save is a key and a value';

/**
 * One key of a save. The value rules are checked by the service against the
 * deployment's own settings list, where each key's owner and field are known.
 * Here only the shape: a key, and a value that is text or null, with a
 * message that names neither, because a value is a secret often enough that
 * no error path may carry one.
 */
const settingEditSchema = object({
  key: string()
    .required()
    .typeError('a settings key is text')
    .matches(SETTINGS_KEY_RE, 'a settings key starts with a letter or an underscore and holds letters, digits and underscores'),
  value: mixed<string>()
    .nullable()
    .defined('a settings value is text, or null to go back to the version')
    .test('text-or-null', 'a settings value is text, or null to go back to the version', (value) => value === null || typeof value === 'string')
    .test('length', `a settings value holds at most ${MAX_VALUE_LENGTH} characters`, (value) => typeof value !== 'string' || value.length <= MAX_VALUE_LENGTH),
})
  .noUnknown(true)
  .typeError(ENTRY_SHAPE_MESSAGE);

export const saveDeploymentSettingsSchema = object({
  expectedInstanceId: string().required().strict().uuid(EXPECTED_INSTANCE_MESSAGE),
  /** The revision the page read. A save is refused once another save has moved past it. */
  expectedRevision: number().required().integer().min(0),
  entries: array().of(settingEditSchema).typeError(ENTRIES_SHAPE_MESSAGE).required().min(1).max(MAX_SAVE_ENTRIES),
}).noUnknown(true);

export type SaveDeploymentSettingsBody = InferType<typeof saveDeploymentSettingsSchema>;

export const applyDeploymentSettingsSchema = object({
  expectedInstanceId: string().required().strict().uuid(EXPECTED_INSTANCE_MESSAGE),
}).noUnknown(true);

export type ApplyDeploymentSettingsBody = InferType<typeof applyDeploymentSettingsSchema>;
