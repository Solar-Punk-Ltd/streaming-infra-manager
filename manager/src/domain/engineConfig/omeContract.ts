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
  engineSettingFieldProblem,
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
const VIRTUAL_HOST = 'VirtualHost';
const NAME_CHILD = 'Name';
const VIRTUAL_HOST_PATH_RE = /^VirtualHosts\/VirtualHost\[[^\]]*\]$/;

const BIND_PORT_RE = /^Bind\/.+\/Port$/;
const ADMISSION_ENABLES_RE = /\/AdmissionWebhooks\/Enables\/Providers$/;
const APPLICATION_NAME_RE = /\/Application\[[^\]]*\]\/Name$/;
const APPLICATION_MEDIA_RE = /\/Application\[[^\]]*\]\/(Providers|Publishers)\/[^/]+$/;
const STREAM_NAME_RE = /\/Application\[[^\]]*\]\/OutputProfiles\/OutputProfile(\[[^\]]*\])?\/OutputStreamName$/;

/**
 * An element that names itself with a Name child, an application, a virtual
 * host or an output profile, is keyed by that name, so two of them never
 * share a path and one with a new name is an addition rather than a copy.
 */
function segmentOf(element: OmeElement): string {
  const name = element.children.find((child) => child.name === NAME_CHILD);
  if (!name || element.children.length < 2) return element.name;
  return `${element.name}[${name.text}]`;
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

/** The path and every path above it, the root left out. */
function prefixesOf(path: string): string[] {
  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Why a container the contract goes through is not in the file exactly as
 * often as in the template, or null. A faithful copy beside a changed twin
 * would otherwise satisfy a check that only asks whether the right value is
 * somewhere at the path.
 */
function multiplicityProblem(
  required: readonly RequiredElement[],
  template: Map<string, string[]>,
  file: Map<string, string[]>,
): string | null {
  const checked = new Set<string>();
  for (const element of required) {
    for (const prefix of prefixesOf(element.path)) {
      if (checked.has(prefix)) continue;
      checked.add(prefix);
      const expected = template.get(prefix)?.length ?? 0;
      const found = file.get(prefix)?.length ?? 0;
      if (found !== expected) {
        return `${prefix} appears ${times(found)} in the file. This version's template has it ${times(expected)}, and the stack's uploader depends on it.`;
      }
    }
  }
  return null;
}

function times(count: number): string {
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return `${count} times`;
}

/**
 * Why the file's shape steps outside what the uploader can admit, or null:
 * a virtual host the template does not have would admit publishers past
 * the webhook, and an application without a name cannot be told apart.
 */
function shapeProblem(template: Map<string, string[]>, file: Map<string, string[]>, root: OmeElement): string | null {
  for (const path of file.keys()) {
    if (VIRTUAL_HOST_PATH_RE.test(path) && !template.has(path)) {
      return `${path} is not in this version's template. Every virtual host must admit publishers through the stack's uploader, so add applications to the template's host instead.`;
    }
  }
  const nameless = (element: OmeElement): boolean =>
    element.children.some(
      (child) =>
        ((child.name === APPLICATION || child.name === VIRTUAL_HOST) &&
          !child.children.some((grandchild) => grandchild.name === NAME_CHILD)) ||
        nameless(child),
    );
  if (nameless(root)) {
    return `An ${APPLICATION} or ${VIRTUAL_HOST} without a ${NAME_CHILD} cannot be told from another. Give it a ${NAME_CHILD}.`;
  }
  return null;
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

/** Whether a literal in place of a placeholder is a value the drawer would accept, by the drawer's own rule. */
function literalProblem(field: EngineSettingField, literal: string): string | null {
  if (literal.trim() === '') {
    return `${field.label} is empty in the file. Give it a value, or put ${field.placeholder} back so the drawer sets it.`;
  }
  const problem = engineSettingFieldProblem(field, literal);
  return problem ? `${problem} That is what the file sets it to.` : null;
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
  const changed = values.find((value) => value !== element.value);
  if (changed === undefined) return null;
  return `${element.path} is ${describeValue(changed)} in the file. This version's template has ${describeValue(element.value)}, and the stack's uploader depends on it.`;
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
  const templateValues = valuesByPath(template.root);
  const values = valuesByPath(file.root);
  const required = requiredSetOf(template.root, engineSettingsFields(OME_SERVICE));
  return (
    shapeProblem(templateValues, values, file.root) ??
    multiplicityProblem(required, templateValues, values) ??
    required.map((element) => problemWith(element, values.get(element.path))).find((problem) => problem !== null) ??
    null
  );
}
