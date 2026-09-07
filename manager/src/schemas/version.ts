import {
  stackRefProblem,
  stackVersionNameProblem,
} from '@streaming-infra-manager/common';
import { boolean, object, string, InferType } from 'yup';

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
}).noUnknown(true);

export type CreateVersionBody = InferType<typeof createVersionSchema>;
export type PatchVersionBody = InferType<typeof patchVersionSchema>;
