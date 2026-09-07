/**
 * What a config file for OvenMediaEngine has to keep from the version's
 * template, derived from the template rather than listed.
 *
 * The stack's uploader admits publishers through the admission webhook and
 * finds streams by application and stream name, so a file may change how the
 * engine encodes and serves but not where it calls back, what it binds, which
 * applications exist, what they provide and publish, or how their streams are
 * named. Those elements are found in the template by path, and the file must
 * carry the same paths with the same values, in any sibling order, with
 * anything else added freely. The two settings the drawer fills may become
 * literals instead of their placeholders, checked as the drawer checks them.
 */
import {
  type EngineSettingField,
  engineSettingsFields,
  OME_SERVICE,
  placeholdersIn,
} from '@streaming-infra-manager/common';

import { type OmeElement, parseOmeXml } from './omeXml.js';

/** An element the file must keep: its path, the template's value, and the drawer field that may set it. */
interface RequiredElement {
  path: string;
  value: string;
  tunable: EngineSettingField | null;
}

const ROOT = 'Server';
const APPLICATION = 'Application';
const APPLICATION_NAME = 'Name';

const BIND_PORT_RE = /^Bind\/.+\/Port$/;
const ADMISSION_ENABLES_RE = /\/AdmissionWebhooks\/Enables\/Providers$/;
const APPLICATION_NAME_RE = /\/Application\[[^\]]*\]\/Name$/;
const APPLICATION_MEDIA_RE = /\/Application\[[^\]]*\]\/(Providers|Publishers)\/[^/]+$/;
const STREAM_NAME_RE = /\/Application\[[^\]]*\]\/OutputProfiles\/OutputProfile\/OutputStreamName$/;

/** An application's path segment names the application, so two applications never share a path. */
function segmentOf(element: OmeElement): string {
  if (element.name !== APPLICATION) return element.name;
  const name = element.children.find((child) => child.name === APPLICATION_NAME)?.text ?? '';
  return `${APPLICATION}[${name}]`;
}

/** Every element under the root by path, with each path's values in document order. */
function valuesByPath(root: OmeElement): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (element: OmeElement, parentPath: string) => {
    for (const child of element.children) {
      const path = parentPath ? `${parentPath}/${segmentOf(child)}` : segmentOf(child);
      const values = found.get(path) ?? [];
      values.push(child.text);
      found.set(path, values);
      walk(child, path);
    }
  };
  walk(root, '');
  return found;
}

function isProtectedPath(path: string): boolean {
  return (
    BIND_PORT_RE.test(path) ||
    ADMISSION_ENABLES_RE.test(path) ||
    APPLICATION_NAME_RE.test(path) ||
    APPLICATION_MEDIA_RE.test(path) ||
    STREAM_NAME_RE.test(path)
  );
}

function requiredSetOf(template: OmeElement, fields: readonly EngineSettingField[]): RequiredElement[] {
  const required: RequiredElement[] = [];
  for (const [path, values] of valuesByPath(template)) {
    for (const value of values) {
      const placeholders = placeholdersIn(value);
      if (placeholders.length > 0) {
        const tunable = fields.find((field) => field.placeholder === value) ?? null;
        required.push({ path, value, tunable });
      } else if (isProtectedPath(path)) {
        required.push({ path, value, tunable: null });
      }
    }
  }
  return required;
}

function describeValue(value: string): string {
  return value === '' ? 'an element with nothing in it' : value;
}

/** Whether a literal in place of a placeholder is a value the drawer would accept for the field. */
function literalProblem(field: EngineSettingField, literal: string): string | null {
  const number = Number(literal);
  const whole = field.kind === 'integer';
  const acceptable =
    literal.trim() !== '' &&
    Number.isFinite(number) &&
    (!whole || Number.isInteger(number)) &&
    (field.min === undefined || number >= field.min) &&
    (field.max === undefined || number <= field.max);
  if (acceptable) return null;
  const range =
    field.min !== undefined && field.max !== undefined
      ? ` between ${field.min} and ${field.max}`
      : '';
  return `${field.label} is ${literal} in the file, and it must be ${whole ? 'a whole number' : 'a number'}${range}.`;
}

function problemWith(element: RequiredElement, values: string[] | undefined): string | null {
  if (!values || values.length === 0) {
    return `${element.path} is missing. This version's template has it as ${describeValue(element.value)}, and the stack's uploader depends on it.`;
  }
  if (element.tunable) {
    for (const value of values) {
      if (value === element.value) continue;
      const problem = literalProblem(element.tunable, value);
      if (problem) return problem;
    }
    return null;
  }
  if (values.includes(element.value)) return null;
  return `${element.path} is ${describeValue(values[0]!)} in the file. This version's template has ${describeValue(element.value)}, and the stack's uploader depends on it.`;
}

/**
 * Why the file does not keep the contract the template sets, in one
 * sentence naming the element, or null. Both texts are expected well formed:
 * a file that is not gets its parser's answer, and a template that is not
 * names itself, because the operator cannot fix it.
 */
export function omeContractProblem(templateXml: string, fileXml: string): string | null {
  const template = parseOmeXml(templateXml);
  if (template.problem !== null) {
    return `This version's OvenMediaEngine template does not parse, so no file can be checked against it. ${template.problem}`;
  }
  const file = parseOmeXml(fileXml);
  if (file.problem !== null) return file.problem;
  if (file.root.name !== ROOT) {
    return `The root element is <${file.root.name}>. OvenMediaEngine reads a <${ROOT}> root.`;
  }
  const values = valuesByPath(file.root);
  for (const element of requiredSetOf(template.root, engineSettingsFields(OME_SERVICE))) {
    const problem = problemWith(element, values.get(element.path));
    if (problem) return problem;
  }
  return null;
}
