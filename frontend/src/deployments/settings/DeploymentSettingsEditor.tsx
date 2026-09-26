import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';

import {
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  engineSettingsFieldsFor,
  getErrorMessage,
} from '@streaming-infra-manager/common';

import { useToast } from '../../app/ToastProvider';
import { ApiError } from '../../http';
import type { Profile } from '../../types';
import { isTransitional } from '../shape';
import { applyDeploymentSettings, saveDeploymentSettings } from './deploymentSettingsApi';
import {
  type DeploymentSettingsDraft,
  EMPTY_DRAFT,
  draftProblems,
  engineDraftProblem,
  pendingEdits,
  saveOf,
  storedEngineProblem,
  withReset,
  withValue,
  withoutEdit,
} from './deploymentSettingsDraft';
import type { SettingRowState } from './DeploymentSettingRow';
import { SettingsDriftBanner } from './SettingsDriftBanner';
import { type EngineFields } from './settingsSections';
import { type SettingReveal, SettingsList } from './SettingsList';
import {
  UNRECORDED_NOTE,
  WHAT_SAVING_DOES,
  appliedText,
  applyRefusalText,
  driftNotice,
  saveNote,
  saveRefusalOf,
  savedText,
  startedBeforeRecords,
  storedEngineProblemText,
  type LoadFailure,
} from './settingsText';
import type { DeploymentSettingsLoad } from './useDeploymentSettings';

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

/** The deployment's own engine settings the list holds, by key, in the order the engine lists them. */
function engineFieldsOf(catalog: DeploymentSettingsCatalog): EngineFields {
  if (catalog.engine === null) return new Map();
  const own = new Set(catalog.entries.filter((entry) => entry.engineSetting !== null).map((entry) => entry.key));
  const fields = engineSettingsFieldsFor(catalog.engine, { abr: catalog.abr }).filter((field) => own.has(field.key));
  return new Map(fields.map((field) => [field.key, field]));
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

/**
 * Every key a deployment's stack version declares, editable for this
 * deployment with the version's value as the default (Levi, 2026-09-25).
 *
 * A component of its own, which the Stack settings card frames and nothing
 * more. A save stores and restarts nothing, and the banner above the list says
 * what the running containers are behind on and offers Apply. The deployment's
 * engine settings are in the same list (Levi, 2026-09-26), shown as the Engine
 * card's drawer showed them, and a pair of them the engine would refuse is
 * named once above Save, which it keeps off. Stored engine settings the next
 * deploy would refuse are named there too and keep no save back, so the save
 * that fixes them, or one of other keys, still goes through. The manager
 * refuses Apply while they stand.
 *
 * The list is the page's own read, which the Engine card and the side column
 * share to mark a value the containers are behind on, and a save that lands
 * says so, because it changed the deployment's row those two read.
 */
export function DeploymentSettingsEditor({
  profile,
  load,
  onSaved,
  reveal = null,
}: {
  profile: Profile;
  load: DeploymentSettingsLoad;
  /** Called once a save has landed. */
  onSaved: () => void;
  /** The latest request from elsewhere on the page to show one of the settings. */
  reveal?: SettingReveal | null;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<DeploymentSettingsDraft>(EMPTY_DRAFT);
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
  const engineProblem = engineDraftProblem(catalog, draft);
  const storedProblem = storedEngineProblem(catalog, draft);
  const saveOff = pending.length === 0 || refused.length > 0 || engineProblem !== null;
  // While a deploy or a stop is under way the manager counts the deployment
  // as not running, which would turn the banner into what Start will use in
  // the middle of Apply's own redeploy. The deploy landing reads the list again.
  const settling = isTransitional(profile);
  const notice = settling ? null : driftNotice(catalog);
  const unrecorded = !settling && startedBeforeRecords(catalog);
  const disabled = busy !== null || profile.status === 'REMOVING';
  const hasEdits = Object.keys(draft.edits).length > 0;

  const edit = (next: (current: DeploymentSettingsDraft) => DeploymentSettingsDraft) => {
    setDraft(next);
    setSaveProblem(null);
  };

  const save = async () => {
    if (disabled || saveOff) return;
    setBusy('saving');
    setSaveProblem(null);
    try {
      await saveDeploymentSettings(profile.name, saveOf(catalog, draft));
      onSaved();
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
        <SettingsDriftBanner notice={notice} unsaved={hasEdits} busy={busy !== null} onApply={() => void apply()} />
      )}

      {applyOutcome && (
        <Alert severity={applyOutcome.severity} onClose={() => setApplyOutcome(null)}>
          {applyOutcome.text}
        </Alert>
      )}

      {unrecorded && (
        <Typography variant="caption" color="text.secondary">
          {UNRECORDED_NOTE}
        </Typography>
      )}

      <SettingsList
        entries={catalog.entries}
        states={states}
        running={catalog.running}
        disabled={disabled}
        onValue={(key, value) => edit((current) => withValue(current, catalog, key, value))}
        onReset={(key) => edit((current) => withReset(current, catalog, key))}
        onUndo={(key) => edit((current) => withoutEdit(current, key))}
        engine={{ fields: engineFieldsOf(catalog), ownConfig: profile.has_engine_config }}
        reveal={reveal}
      />

      {engineProblem && (
        <Alert severity="warning" sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
          {engineProblem}
        </Alert>
      )}

      {storedProblem && (
        <Alert severity="error" sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
          {storedEngineProblemText(storedProblem)}
        </Alert>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Button
          variant="contained"
          size="small"
          disabled={disabled || saveOff}
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
