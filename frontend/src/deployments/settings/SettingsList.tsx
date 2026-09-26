import { useState } from 'react';
import { Box, InputAdornment, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { DeploymentSettingRow, type SettingRowState } from './DeploymentSettingRow';
import { type EngineFields, filteredSections, isSectionOpen, sectionsOf } from './settingsSections';
import { SettingsSectionFold } from './SettingsSectionFold';
import { noMatchText, type SectionCounts, type SettingsEditTarget } from './settingsText';

const UNTOUCHED_ROW: SettingRowState = { edit: undefined, pending: false, behind: false, problem: null };

/** A deployment's own engine settings as the list shows them: their fields in common, and the config the engine runs. */
export interface EngineSettingsView {
  fields: EngineFields;
  /** Whether the engine runs a config file of the deployment's own rather than the version's template. */
  ownConfig: boolean;
}

const NO_ENGINE_SETTINGS: EngineSettingsView = { fields: new Map(), ownConfig: false };

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
  onValue,
  onReset,
  onUndo,
}: SettingsListProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const sections = filteredSections(sectionsOf(entries, engine.fields), query, engine.fields);

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
