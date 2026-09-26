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

const VALUE_LENGTH_MESSAGE = `a settings value holds at most ${MAX_VALUE_LENGTH} characters`;

const settingKeyField = () =>
  string()
    .required()
    .typeError('a settings key is text')
    .matches(SETTINGS_KEY_RE, 'a settings key starts with a letter or an underscore and holds letters, digits and underscores');

const withinValueLength = (value: unknown): boolean => typeof value !== 'string' || value.length <= MAX_VALUE_LENGTH;

/**
 * yup's own message for a value of the wrong type repeats the value, and a
 * list of settings sent as a map or as `KEY=value` strings carries its secrets
 * in exactly that value.
 */
const ENTRIES_SHAPE_MESSAGE = 'entries is a list of settings, each a key and a value';
const ENTRY_SHAPE_MESSAGE = 'each entry of a save is a key and a value';
const NEW_SETTINGS_SHAPE_MESSAGE = 'stack_settings is a list of settings, each a key and a value';
const NEW_SETTING_SHAPE_MESSAGE = 'each entry of stack_settings is a key and a value';

/**
 * One key of a save. The value rules are checked by the service against the
 * deployment's own settings list, where each key's owner and field are known.
 * Here only the shape: a key, and a value that is text or null, with a
 * message that names neither, because a value is a secret often enough that
 * no error path may carry one.
 */
const settingEditSchema = object({
  key: settingKeyField(),
  value: mixed<string>()
    .nullable()
    .defined('a settings value is text, or null to go back to the version')
    .test('text-or-null', 'a settings value is text, or null to go back to the version', (value) => value === null || typeof value === 'string')
    .test('length', VALUE_LENGTH_MESSAGE, withinValueLength),
})
  .noUnknown(true)
  .typeError(ENTRY_SHAPE_MESSAGE);

/**
 * One key a new deployment is created with. Nothing is stored yet, so there
 * is nothing to go back to and the value is text. The same shape rules as a
 * save's, with messages that name no value.
 */
const newDeploymentSettingSchema = object({
  key: settingKeyField(),
  value: mixed<string>()
    .defined('a settings value is text')
    .test('text', 'a settings value is text', (value) => typeof value === 'string')
    .test('length', VALUE_LENGTH_MESSAGE, withinValueLength),
})
  .noUnknown(true)
  .typeError(NEW_SETTING_SHAPE_MESSAGE);

/**
 * The stack settings a create body carries, in `POST /profiles` and `POST
 * /groups`, or nothing. Whether the version declares each key, whether a
 * control of the deployment decides it, and whether the stack takes the
 * value are the service's to answer, against the list the version gives a
 * deployment of the shape the body describes.
 */
export const newDeploymentSettingsField = () =>
  array()
    .of(newDeploymentSettingSchema)
    .typeError(NEW_SETTINGS_SHAPE_MESSAGE)
    .notRequired()
    .default(undefined)
    .max(MAX_SAVE_ENTRIES);

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
