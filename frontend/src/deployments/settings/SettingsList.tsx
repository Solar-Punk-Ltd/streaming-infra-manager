import { useEffect, useState } from 'react';
import { Box, InputAdornment, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { DeploymentSettingRow, type SettingRowState } from './DeploymentSettingRow';
import { type EngineFields, filteredSections, isSectionOpen, sectionIdHolding, sectionsOf } from './settingsSections';
import { SettingsSectionFold } from './SettingsSectionFold';
import { settingFieldId } from './settingFieldIds';
import { noMatchText, type SectionCounts, type SettingsEditTarget } from './settingsText';

const UNTOUCHED_ROW: SettingRowState = { edit: undefined, pending: false, behind: false, problem: null };

/** A deployment's own engine settings as the list shows them: their fields in common, and the config the engine runs. */
export interface EngineSettingsView {
  fields: EngineFields;
  /** Whether the engine runs a config file of the deployment's own rather than the version's template. */
  ownConfig: boolean;
}

const NO_ENGINE_SETTINGS: EngineSettingsView = { fields: new Map(), ownConfig: false };

/**
 * A request from elsewhere on the page to bring one key of the list into view
 * with its field focused, numbered so that asking for the same key again is a
 * request of its own.
 */
export interface SettingReveal {
  key: string;
  seq: number;
}

/**
 * A key a reveal asked for, not yet shown. A fold that is still opening clips
 * the rows it holds, and scrolling to one of them then scrolls the fold rather
 * than the page, which leaves the row off screen once the fold has opened. So
 * a key whose section had to open is shown when that fold has opened.
 */
interface PendingReveal {
  key: string;
  /** The section whose fold is opening for the key, or null when none had to open. */
  opening: string | null;
}

export interface SettingsListProps {
  entries: readonly DeploymentSettingEntry[];
  /** Where each key stands against the edit in progress, by key. A key left out is untouched. */
  states: ReadonlyMap<string, SettingRowState>;
  /** Whether the deployment's containers run, which decides what a saved change still waits for. */
  running: boolean;
  disabled: boolean;
  target?: SettingsEditTarget;
  /** For keys a control decides, the value a control on the same form gives each, by key. */
  controlValues?: Readonly<Record<string, string>>;
  /** The deployment's own engine settings, gathered in a section of their own and shown by their fields. None for the wizard's list. */
  engine?: EngineSettingsView;
  /** The latest request to show a key, which opens its section and focuses its field. */
  reveal?: SettingReveal | null;
  onValue: (key: string, value: string) => void;
  onReset: (key: string) => void;
  onUndo: (key: string) => void;
}

function countsOf(entries: readonly DeploymentSettingEntry[], states: ReadonlyMap<string, SettingRowState>): SectionCounts {
  const of = (entry: DeploymentSettingEntry) => states.get(entry.key);
  return {
    unsaved: entries.filter((entry) => of(entry)?.pending).length,
    refused: entries.filter((entry) => of(entry)?.problem).length,
    behind: entries.filter((entry) => of(entry)?.behind && !of(entry)?.pending).length,
  };
}

function engineRowOf(engine: EngineSettingsView, key: string) {
  const field = engine.fields.get(key);
  return field ? { field, ownConfig: engine.ownConfig } : undefined;
}

function toggled(opened: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(opened);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Scrolls a key's row to the middle of the page and puts the cursor in its field. */
function showField(key: string): void {
  const field = document.getElementById(settingFieldId(key));
  (field?.closest('li') ?? field)?.scrollIntoView({ block: 'center' });
  field?.focus({ preventScroll: true });
}

/**
 * The keys of a settings list with a search over them, folded by the
 * sample's sections, each key with the field that edits it. Whatever renders
 * it holds the edit and decides what becomes of it.
 */
export function SettingsList({
  entries,
  states,
  running,
  disabled,
  target = 'deployment',
  controlValues = {},
  engine = NO_ENGINE_SETTINGS,
  reveal = null,
  onValue,
  onReset,
  onUndo,
}: SettingsListProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<PendingReveal | null>(null);
  const allSections = sectionsOf(entries, engine.fields);
  const sections = filteredSections(allSections, query, engine.fields);

  // A search could hide the key and a fold hides every key of its section, so
  // a request to show one clears the first and opens the second. A fold that
  // is still opening for an earlier request is still opening for this one.
  useEffect(() => {
    if (!reveal) return;
    const section = sectionIdHolding(allSections, reveal.key);
    const opening = section !== null && (pending?.opening === section || !isSectionOpen(section, opened, query));
    setQuery('');
    if (section) setOpened((current) => new Set([...current, section]));
    setPending({ key: reveal.key, opening: opening ? section : null });
    // Asked once per request: the sections of the render the request arrived in are the ones it means.
  }, [reveal]);

  useEffect(() => {
    if (pending === null || pending.opening !== null) return;
    showField(pending.key);
    setPending(null);
  }, [pending]);

  const showOnceOpened = (id: string) => {
    if (pending === null || pending.opening !== id) return;
    showField(pending.key);
    setPending(null);
  };

  return (
    <>
      <TextField
        size="small"
        fullWidth
        value={query}
        placeholder="Search by key or description"
        onChange={(event) => setQuery(event.target.value)}
        inputProps={{ 'aria-label': 'Search settings', spellCheck: false, autoComplete: 'off' }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {sections.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {query.trim() === '' ? 'This version declares no settings.' : noMatchText(query)}
        </Typography>
      ) : (
        <Box sx={{ borderBottom: 1, borderColor: 'divider', minWidth: 0 }}>
          {sections.map((section) => (
            <SettingsSectionFold
              key={section.id}
              section={section}
              open={isSectionOpen(section.id, opened, query)}
              counts={countsOf(section.entries, states)}
              target={target}
              onToggle={() => setOpened((current) => toggled(current, section.id))}
              onOpened={() => showOnceOpened(section.id)}
            >
              {section.entries.map((entry) => (
                <DeploymentSettingRow
                  key={entry.key}
                  entry={entry}
                  state={states.get(entry.key) ?? UNTOUCHED_ROW}
                  running={running}
                  disabled={disabled}
                  target={target}
                  controlValue={controlValues[entry.key]}
                  engine={engineRowOf(engine, entry.key)}
                  onValue={(value) => onValue(entry.key, value)}
                  onReset={() => onReset(entry.key)}
                  onUndo={() => onUndo(entry.key)}
                />
              ))}
            </SettingsSectionFold>
          ))}
        </Box>
      )}
    </>
  );
}
