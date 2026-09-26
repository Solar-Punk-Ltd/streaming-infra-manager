import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

/** One fold of the settings list: the keys the version's sample declares under one section title. */
export interface SettingsSection {
  /** Stable across reads of the list, so a section the operator opened stays open. */
  id: string;
  title: string;
  entries: DeploymentSettingEntry[];
}

/** Where a key declared before any section title goes. */
export const OTHER_SECTION_TITLE = 'Other';

/** Where the keys the deployment still stores but its version no longer declares go, last. */
export const UNDECLARED_SECTION_TITLE = 'No longer declared by this version';

const UNDECLARED_SECTION_ID = 'undeclared';

function sectionIdOf(title: string): string {
  return `section:${title}`;
}

/**
 * The keys folded by the sample's sections, in the order each section first
 * appears and the keys in the order the list gives them. A title met twice,
 * as when the root sample and the engine's both have one, is one section.
 */
export function sectionsOf(entries: readonly DeploymentSettingEntry[]): SettingsSection[] {
  const sections = new Map<string, SettingsSection>();
  const undeclared: DeploymentSettingEntry[] = [];
  for (const entry of entries) {
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
  const declared = [...sections.values()];
  return undeclared.length === 0
    ? declared
    : [...declared, { id: UNDECLARED_SECTION_ID, title: UNDECLARED_SECTION_TITLE, entries: undeclared }];
}

function searchTermOf(query: string): string {
  return query.trim().toLowerCase();
}

function matches(entry: DeploymentSettingEntry, term: string): boolean {
  return entry.key.toLowerCase().includes(term) || entry.description.toLowerCase().includes(term);
}

/** The sections with only the keys whose name or description holds the search, and no empty section. */
export function filteredSections(sections: readonly SettingsSection[], query: string): SettingsSection[] {
  const term = searchTermOf(query);
  if (term === '') return [...sections];
  return sections
    .map((section) => ({ ...section, entries: section.entries.filter((entry) => matches(entry, term)) }))
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
