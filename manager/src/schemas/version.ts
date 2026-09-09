import {
  settingValueProblem,
  stackRefProblem,
  stackVersionNameProblem,
} from '@streaming-infra-manager/common';
import { array, boolean, number, object, string, InferType } from 'yup';

import { DEPLOY_CONFIG } from '../domain/versions/hostConfigCapture.js';

/**
 * The id arrives as a path segment, so it is checked as the digits it is and
 * parsed by the route. Validating it as a number here would put a number back
 * into `req.params`, where every other value is a string.
 */
const VERSION_ID_RE = /^[1-9][0-9]{0,8}$/;

export const versionIdSchema = object({
  id: string()
    .required()
    .matches(VERSION_ID_RE, 'version id must be a positive whole number'),
}).noUnknown(true);

export const createVersionSchema = object({
  name: string()
    .required()
    .test('version-name', 'invalid version name', function (value) {
      const problem = stackVersionNameProblem(value ?? '');
      return problem ? this.createError({ message: problem }) : true;
    }),
  ref: string()
    .required()
    .test('version-ref', 'invalid branch or tag', function (value) {
      const problem = stackRefProblem(value ?? '');
      return problem ? this.createError({ message: problem }) : true;
    }),
}).noUnknown(true);

export const patchVersionSchema = object({
  tested: boolean().required(),
  /** The commit the page showed. Required to turn tested on: approval names a build, not a name. */
  commitSha: string()
    .nullable()
    .notRequired()
    .when('tested', {
      is: true,
      then: (schema) =>
        schema.required('commitSha names the build being marked as tested'),
    }),
  /** Null only for an explicitly legacy row. The service checks its layout. */
  buildId: string().nullable().notRequired(),
}).noUnknown(true);

export type CreateVersionBody = InferType<typeof createVersionSchema>;
export type PatchVersionBody = InferType<typeof patchVersionSchema>;

// ------------------------------------------------------------ the settings

/** As the env files spell a key, and nothing that could escape a line. */
const SETTINGS_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The paths a save may name: the base env, the deploy config, one env per
 * engine. Checked as a shape here and against the version's own files by the
 * service, because these become paths under the version's config root.
 */
const SETTINGS_PATH_RE = /^(?:\.env|deploy\/config\.json|engines\/[A-Za-z0-9_-]+\/\.env)$/;

/**
 * The value rule is `common`'s, so the page shows the same refusal under the
 * field before the save is ever sent. The message names the key and never the
 * value, which is a secret often enough that no error path may carry one, and
 * `typeError` replaces yup's own message for the same reason.
 */
const settingsEntrySchema = object({
  key: string()
    .required()
    .typeError('a settings key is text')
    .matches(
      SETTINGS_KEY_RE,
      'a settings key starts with a letter or an underscore and holds letters, digits and underscores',
    ),
  value: string()
    .defined()
    .typeError('a settings value is text')
    .test('settings-value', 'that is not a value this key can hold', function (value) {
      const key = typeof this.parent.key === 'string' ? this.parent.key : '';
      const problem = settingValueProblem(key, value ?? '');
      return problem ? this.createError({ message: `${key} ${problem}` }) : true;
    }),
  /** Deletes the key's line rather than assigning it. */
  remove: boolean().notRequired(),
}).noUnknown(true);

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const settingsFileSchema = object({
  path: string()
    .required()
    .matches(SETTINGS_PATH_RE, 'that is not a settings file of a stack version'),
  entries: array().of(settingsEntrySchema).notRequired(),
  text: string().typeError(`${DEPLOY_CONFIG} is text`).notRequired(),
})
  .noUnknown(true)
  .test(
    'file-kind',
    `an env file is saved as keys and ${DEPLOY_CONFIG} as text`,
    (file) =>
      file.path === DEPLOY_CONFIG
        ? typeof file.text === 'string' && file.entries === undefined
        : Array.isArray(file.entries) && file.text === undefined,
  )
  .test(
    'json-parses',
    `${DEPLOY_CONFIG} has to be JSON the deploy scripts can read`,
    (file) => file.path !== DEPLOY_CONFIG || parsesAsJson(file.text ?? ''),
  );

export const saveVersionSettingsSchema = object({
  /** The revision the page loaded. A save is refused once anything has moved past it. */
  expectedGeneration: number().integer().min(1).required(),
  files: array().of(settingsFileSchema).required().min(1),
}).noUnknown(true);
