import type { DeploymentSettingEntry, EngineSettingField } from '@streaming-infra-manager/common';

/** One fold of the settings list: the keys the version's sample declares under one section title. */
export interface SettingsSection {
  /** Stable across reads of the list, so a section the operator opened stays open. */
  id: string;
  title: string;
  entries: DeploymentSettingEntry[];
}

/** The engine settings a deployment reads, by key, in the order its engine lists them. */
export type EngineFields = ReadonlyMap<string, EngineSettingField>;

const NO_ENGINE_FIELDS: EngineFields = new Map();

/** Where a deployment's own engine settings go, first, whichever sample section declares them. */
export const ENGINE_SECTION_TITLE = 'Engine settings';

const ENGINE_SECTION_ID = 'engine';

/** Where a key declared before any section title goes. */
export const OTHER_SECTION_TITLE = 'Other';

/** Where the keys the deployment still stores but its version no longer declares go, last. */
export const UNDECLARED_SECTION_TITLE = 'No longer declared by this version';

const UNDECLARED_SECTION_ID = 'undeclared';

function sectionIdOf(title: string): string {
  return `section:${title}`;
}

/** The engine settings among the keys, in the order their engine lists them, which an operator tunes together. */
function engineSectionOf(entries: readonly DeploymentSettingEntry[], engineFields: EngineFields): SettingsSection[] {
  const byKey = new Map(entries.filter((entry) => engineFields.has(entry.key)).map((entry) => [entry.key, entry]));
  const engine = [...engineFields.keys()].flatMap((key) => byKey.get(key) ?? []);
  return engine.length === 0 ? [] : [{ id: ENGINE_SECTION_ID, title: ENGINE_SECTION_TITLE, entries: engine }];
}

/**
 * The keys folded by the sample's sections, in the order each section first
 * appears and the keys in the order the list gives them. A title met twice,
 * as when the root sample and the engine's both have one, is one section. A
 * deployment's own engine settings come first, in a section of their own.
 */
export function sectionsOf(
  entries: readonly DeploymentSettingEntry[],
  engineFields: EngineFields = NO_ENGINE_FIELDS,
): SettingsSection[] {
  const sections = new Map<string, SettingsSection>();
  const undeclared: DeploymentSettingEntry[] = [];
  for (const entry of entries) {
    if (engineFields.has(entry.key)) continue;
    if (!entry.declared) {
      undeclared.push(entry);
      continue;
    }
    const title = entry.section === '' ? OTHER_SECTION_TITLE : entry.section;
    const id = sectionIdOf(title);
    const section = sections.get(id) ?? { id, title, entries: [] };
    section.entries.push(entry);
    sections.set(id, section);
  }
  const declared = [...engineSectionOf(entries, engineFields), ...sections.values()];
  return undeclared.length === 0
    ? declared
    : [...declared, { id: UNDECLARED_SECTION_ID, title: UNDECLARED_SECTION_TITLE, entries: undeclared }];
}

/** The id of the section a key is folded in, or null for a key the list does not hold. */
export function sectionIdHolding(sections: readonly SettingsSection[], key: string): string | null {
  return sections.find((section) => section.entries.some((entry) => entry.key === key))?.id ?? null;
}

function searchTermOf(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether a key's name, its description, or for an engine setting its label and help, hold the search. */
function matches(entry: DeploymentSettingEntry, term: string, field: EngineSettingField | undefined): boolean {
  const texts = [entry.key, entry.description, field?.label ?? '', field?.help ?? ''];
  return texts.some((text) => text.toLowerCase().includes(term));
}

/** The sections with only the keys whose name or description holds the search, and no empty section. */
export function filteredSections(
  sections: readonly SettingsSection[],
  query: string,
  engineFields: EngineFields = NO_ENGINE_FIELDS,
): SettingsSection[] {
  const term = searchTermOf(query);
  if (term === '') return [...sections];
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => matches(entry, term, engineFields.get(entry.key))),
    }))
    .filter((section) => section.entries.length > 0);
}

/**
 * Whether a section shows its keys. Folded until the operator opens it, and
 * open while a search is on, because a search keeps only sections that hold a
 * match, and a match inside a fold is a match nobody sees.
 */
export function isSectionOpen(id: string, opened: ReadonlySet<string>, query: string): boolean {
  return searchTermOf(query) !== '' || opened.has(id);
}
