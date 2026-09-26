import { useState } from 'react';
import { Box, InputAdornment, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { DeploymentSettingRow, type SettingRowState } from './DeploymentSettingRow';
import { filteredSections, isSectionOpen, sectionsOf } from './settingsSections';
import { SettingsSectionFold } from './SettingsSectionFold';
import { noMatchText, type SectionCounts } from './settingsText';

const UNTOUCHED_ROW: SettingRowState = { edit: undefined, pending: false, behind: false, problem: null };

export interface SettingsListProps {
  entries: readonly DeploymentSettingEntry[];
  /** Where each key stands against the edit in progress, by key. A key left out is untouched. */
  states: ReadonlyMap<string, SettingRowState>;
  /** Whether the deployment's containers run, which decides what a saved change still waits for. */
  running: boolean;
  disabled: boolean;
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
export function SettingsList({ entries, states, running, disabled, onValue, onReset, onUndo }: SettingsListProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const sections = filteredSections(sectionsOf(entries), query);

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
              onToggle={() => setOpened((current) => toggled(current, section.id))}
            >
              {section.entries.map((entry) => (
                <DeploymentSettingRow
                  key={entry.key}
                  entry={entry}
                  state={states.get(entry.key) ?? UNTOUCHED_ROW}
                  running={running}
                  disabled={disabled}
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
