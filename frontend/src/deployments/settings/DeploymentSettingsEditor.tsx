import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

import {
  type DeploymentSettingEntry,
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  getErrorMessage,
} from '@streaming-infra-manager/common';

import { useToast } from '../../app/ToastProvider';
import { ApiError } from '../../http';
import type { Profile } from '../../types';
import { applyDeploymentSettings, saveDeploymentSettings } from './deploymentSettingsApi';
import {
  type DeploymentSettingsDraft,
  EMPTY_DRAFT,
  draftProblems,
  pendingEdits,
  saveOf,
  withReset,
  withValue,
  withoutEdit,
} from './deploymentSettingsDraft';
import { DeploymentSettingRow, type SettingRowState } from './DeploymentSettingRow';
import { SettingsDriftBanner } from './SettingsDriftBanner';
import { filteredSections, isSectionOpen, sectionsOf, type SettingsSection } from './settingsSections';
import { SettingsSectionFold } from './SettingsSectionFold';
import {
  WHAT_SAVING_DOES,
  appliedText,
  applyOffReason,
  applyRefusalText,
  driftNotice,
  noMatchText,
  saveNote,
  saveRefusalOf,
  savedText,
  unknownNote,
  type LoadFailure,
  type SectionCounts,
} from './settingsText';
import { useDeploymentSettings } from './useDeploymentSettings';

type Busy = 'saving' | 'applying' | null;

interface ApplyOutcome {
  severity: 'success' | 'info' | 'warning';
  text: string;
}

function recreatedNothing(applied: DeploymentSettingsApplied): boolean {
  return applied.recreated !== 'all' && applied.recreated.length === 0;
}

function refusalOf(caught: unknown): { message: string; reload: boolean } {
  return caught instanceof ApiError ? saveRefusalOf(caught.code, caught.message) : { message: getErrorMessage(caught), reload: false };
}

/** Where every key stands against the draft and the containers, by key. */
function rowStatesOf(catalog: DeploymentSettingsCatalog, draft: DeploymentSettingsDraft): Map<string, SettingRowState> {
  const pending = new Set(pendingEdits(catalog, draft).map(({ key }) => key));
  const problems = draftProblems(catalog, draft);
  const behind = new Set(catalog.drift.keys);
  return new Map(
    catalog.entries.map((entry) => [
      entry.key,
      {
        edit: draft.edits[entry.key],
        pending: pending.has(entry.key),
        behind: behind.has(entry.key),
        problem: problems[entry.key] ?? null,
      },
    ]),
  );
}

function countsOf(entries: readonly DeploymentSettingEntry[], states: Map<string, SettingRowState>): SectionCounts {
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
 * Every key a deployment's stack version declares, editable for this
 * deployment with the version's value as the default (Levi, 2026-09-25).
 *
 * A component of its own rather than a card, because where it lives is still
 * Levi's to choose between a card, a page of its own and a tab. Whatever holds
 * it is a frame and nothing more. A save stores and restarts nothing, and the
 * banner above the list says what the running containers are behind on and
 * offers Apply.
 */
export function DeploymentSettingsEditor({ profile }: { profile: Profile }) {
  const toast = useToast();
  const load = useDeploymentSettings(profile);
  const [draft, setDraft] = useState<DeploymentSettingsDraft>(EMPTY_DRAFT);
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [applyOutcome, setApplyOutcome] = useState<ApplyOutcome | null>(null);
  const { catalog } = load;

  if (!catalog) {
    if (!load.failure) {
      return (
        <Stack alignItems="center" sx={{ py: 3 }}>
          <CircularProgress size={24} aria-label="Reading the settings" />
        </Stack>
      );
    }
    return <LoadFailureAlert failure={load.failure} onRetry={() => void load.reload()} />;
  }

  const states = rowStatesOf(catalog, draft);
  const pending = pendingEdits(catalog, draft);
  const refused = Object.keys(draftProblems(catalog, draft));
  const notice = driftNotice(catalog);
  const unknownCount = catalog.running ? catalog.entries.filter((entry) => entry.running === 'unknown').length : 0;
  const sections = filteredSections(sectionsOf(catalog.entries), query);
  const disabled = busy !== null || profile.status === 'REMOVING';
  const hasEdits = Object.keys(draft.edits).length > 0;

  const edit = (next: (current: DeploymentSettingsDraft) => DeploymentSettingsDraft) => {
    setDraft(next);
    setSaveProblem(null);
  };

  const save = async () => {
    if (disabled || pending.length === 0 || refused.length > 0) return;
    setBusy('saving');
    setSaveProblem(null);
    try {
      await saveDeploymentSettings(profile.name, saveOf(catalog, draft));
      setApplyOutcome(null);
      toast(savedText(catalog.running), 'success');
      await load.reload();
      setDraft(EMPTY_DRAFT);
    } catch (caught) {
      const refusal = refusalOf(caught);
      setSaveProblem(refusal.message);
      if (refusal.reload) {
        await load.reload();
        setDraft(EMPTY_DRAFT);
      }
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (disabled) return;
    setBusy('applying');
    setApplyOutcome(null);
    try {
      const applied = await applyDeploymentSettings(profile.name, catalog.instanceId);
      setApplyOutcome({ severity: recreatedNothing(applied) ? 'info' : 'success', text: appliedText(applied) });
      await load.reload();
    } catch (caught) {
      const text = caught instanceof ApiError ? applyRefusalText(caught.code, caught.message) : getErrorMessage(caught);
      setApplyOutcome({ severity: 'warning', text });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">
        {WHAT_SAVING_DOES}
      </Typography>

      {load.failure && <LoadFailureAlert failure={load.failure} onRetry={() => void load.reload()} />}

      {notice && (
        <SettingsDriftBanner
          notice={notice}
          unsaved={hasEdits}
          applyOffBecause={applyOffReason(profile)}
          applying={busy === 'applying'}
          onApply={() => void apply()}
        />
      )}

      {applyOutcome && (
        <Alert severity={applyOutcome.severity} onClose={() => setApplyOutcome(null)}>
          {applyOutcome.text}
        </Alert>
      )}

      {!notice && unknownCount > 0 && (
        <Typography variant="caption" color="text.secondary">
          {unknownNote(unknownCount)}
        </Typography>
      )}

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

      <SectionList
        sections={sections}
        query={query}
        opened={opened}
        states={states}
        running={catalog.running}
        disabled={disabled}
        onToggle={(id) => setOpened((current) => toggled(current, id))}
        onValue={(key, value) => edit((current) => withValue(current, catalog, key, value))}
        onReset={(key) => edit((current) => withReset(current, catalog, key))}
        onUndo={(key) => edit((current) => withoutEdit(current, key))}
      />

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Button
          variant="contained"
          size="small"
          disabled={disabled || pending.length === 0 || refused.length > 0}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button size="small" disabled={disabled || !hasEdits} onClick={() => edit(() => EMPTY_DRAFT)}>
          Discard
        </Button>
        <Box sx={{ flex: '1 1 auto' }} />
        <Typography variant="caption" color={refused.length > 0 ? 'error.main' : 'text.secondary'} sx={{ overflowWrap: 'anywhere' }}>
          {saveNote(pending.length, refused)}
        </Typography>
      </Stack>

      {saveProblem && (
        <Alert severity="error" sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
          {saveProblem}
        </Alert>
      )}
    </Stack>
  );
}

function SectionList({
  sections,
  query,
  opened,
  states,
  running,
  disabled,
  onToggle,
  onValue,
  onReset,
  onUndo,
}: {
  sections: SettingsSection[];
  query: string;
  opened: ReadonlySet<string>;
  states: Map<string, SettingRowState>;
  running: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
  onValue: (key: string, value: string) => void;
  onReset: (key: string) => void;
  onUndo: (key: string) => void;
}) {
  if (sections.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {query.trim() === '' ? 'This version declares no settings.' : noMatchText(query)}
      </Typography>
    );
  }
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', minWidth: 0 }}>
      {sections.map((section) => (
        <SettingsSectionFold
          key={section.id}
          section={section}
          open={isSectionOpen(section.id, opened, query)}
          counts={countsOf(section.entries, states)}
          onToggle={() => onToggle(section.id)}
        >
          {section.entries.map((entry) => (
            <DeploymentSettingRow
              key={entry.key}
              entry={entry}
              state={states.get(entry.key) ?? { edit: undefined, pending: false, behind: false, problem: null }}
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
  );
}

function LoadFailureAlert({
  failure,
  onRetry,
}: {
  failure: LoadFailure;
  onRetry: () => void;
}) {
  return (
    <Alert
      severity={failure.severity}
      sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {failure.message}
    </Alert>
  );
}
