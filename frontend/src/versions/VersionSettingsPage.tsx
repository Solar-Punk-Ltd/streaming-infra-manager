import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';

import {
  getErrorMessage,
  type StackSettings,
  type StackSettingsApplied,
  type StackSettingsFileEdit,
} from '@streaming-infra-manager/common';

import { navigate, routes } from '../app/router';
import { useDeployments } from '../app/useDeploymentsStore';
import { useToast } from '../app/ToastProvider';
import { MONO_STACK } from '../app/theme';
import { SectionCard } from '../components/SectionCard';
import { ApiError } from '../http';

import { SettingsFileCard } from './SettingsFileCard';
import {
  applyVersionSettings,
  fetchVersionSettings,
  saveVersionSettings,
} from './settingsApi';
import {
  draftOf,
  editedFiles,
  keysWithAValueProblem,
  settingsRefusal,
  withEntry,
  withRemoval,
  withText,
  type SettingsDraft,
  type SettingsRefusal,
} from './settingsDraft';

const WHAT_APPLIES_WHEN =
  'Saving writes these files on this host. A deployment reads them from the build it runs, so a saved change reaches new deployments only once Apply has made a build that carries it. Deployments already running keep the settings they started with until they are deployed again.';

/** Whether the build new deployments would run holds the revision that was saved. */
function isCarriedByTheBuild(settings: StackSettings): boolean {
  return settings.buildGeneration !== null && settings.buildGeneration === settings.generation;
}

function unappliedRevisionNote(settings: StackSettings): string | null {
  if (settings.buildGeneration === null || isCarriedByTheBuild(settings)) return null;
  return `Saved as revision ${settings.generation}. The current build carries revision ${settings.buildGeneration}, so new deployments do not have these changes yet. Apply makes a build that does.`;
}

/**
 * What the footer says about the edit in progress. A value the manager would
 * refuse comes first, because that is what the two save actions are off for.
 */
function footerNote(edits: readonly StackSettingsFileEdit[], refused: readonly string[]): string {
  if (refused.length > 0) {
    const count = refused.length === 1 ? 'One value' : `${refused.length} values`;
    return `${count} cannot be saved as written: ${refused.join(', ')}`;
  }
  if (edits.length === 0) return 'Nothing changed yet';
  return `${edits.length} ${edits.length === 1 ? 'file' : 'files'} changed`;
}

type Busy = 'saving' | 'applying' | null;

/**
 * The host-owned settings of one stack version, as a page.
 *
 * These are the files that used to be editable only through
 * `stack-config-edit.sh` over ssh: the base environment, the deploy config and
 * one environment per engine. The version's own samples say what each key is
 * for, and that is the text under each field.
 */
export function VersionSettingsPage({ id }: { id: number }) {
  const { versions, reloadVersions } = useDeployments();
  const toast = useToast();
  const [settings, setSettings] = useState<StackSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState<SettingsRefusal | null>(null);
  const [applied, setApplied] = useState<StackSettingsApplied | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const version = versions?.find((row) => row.id === id) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const answer = await fetchVersionSettings(id);
      setSettings(answer);
      setDraft(draftOf(answer));
      setRefusal(null);
    } catch (caught) {
      setSettings(null);
      setRefusal(
        caught instanceof ApiError
          ? settingsRefusal(caught.code, caught.message)
          : { message: getErrorMessage(caught), retry: null },
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const edits = settings ? editedFiles(settings, draft) : [];
  const refusedKeys = keysWithAValueProblem(edits);
  const disabled = busy !== null || settings === null;
  // A save carrying one of these comes back a 400 having written nothing, so
  // the round trip buys the operator only the wait. Discard stays on, because
  // it is the way back out of the value.
  const saveDisabled = disabled || refusedKeys.length > 0;

  const run = async (kind: Busy, action: () => Promise<void>) => {
    setBusy(kind);
    setRefusal(null);
    try {
      await action();
    } catch (caught) {
      setRefusal(
        caught instanceof ApiError
          ? settingsRefusal(caught.code, caught.message)
          : { message: getErrorMessage(caught), retry: null },
      );
    } finally {
      setBusy(null);
    }
  };

  /**
   * The revision the save landed on is carried into the page state before
   * anything else can throw. Without it a refused apply left the page naming
   * the revision it loaded with, and the operator's next save was refused as a
   * change somebody else had made, which was their own.
   */
  const saveEdits = async (): Promise<void> => {
    if (!settings || edits.length === 0) return;
    const saved = await saveVersionSettings(id, settings.generation, edits);
    setSettings((current) => (current ? { ...current, generation: saved.generation } : current));
  };

  const save = () =>
    run('saving', async () => {
      await saveEdits();
      await load();
      setApplied(null);
      toast('Settings saved on this host', 'success');
    });

  const saveAndApply = () =>
    run('applying', async () => {
      await saveEdits();
      try {
        const outcome = await applyVersionSettings(id);
        setApplied(outcome);
        reloadVersions();
        toast(`New deployments run build ${outcome.buildId}`, 'success');
      } finally {
        await load();
      }
    });

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button size="small" onClick={() => navigate(routes.versions)}>
          Back to versions
        </Button>
        <Typography variant="body2" color="text.secondary">
          Settings for {version?.name ?? `version ${id}`}
        </Typography>
        {settings && (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO_STACK }}>
            revision {settings.generation}
            {settings.buildId ? `, build ${settings.buildId.slice(0, 7)}` : ''}
          </Typography>
        )}
        {settings && isCarriedByTheBuild(settings) && (
          <Chip size="small" variant="outlined" color="success" label="applied" />
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {WHAT_APPLIES_WHEN}
      </Typography>

      {refusal && (
        <Alert
          severity="warning"
          action={
            refusal.retry && (
              <Button color="inherit" size="small" onClick={() => void load()}>
                {refusal.retry}
              </Button>
            )
          }
        >
          {refusal.message}
        </Alert>
      )}

      {settings && settings.leftAlone.length > 0 && (
        <Alert severity="warning">
          Nothing here reads {settings.leftAlone.join(', ')}: there is a link or a directory at each
          of those paths rather than a file. Put a regular file there on the host if it is meant to
          be a setting of this version.
        </Alert>
      )}

      {settings && unappliedRevisionNote(settings) && (
        <Alert severity="info">{unappliedRevisionNote(settings)}</Alert>
      )}

      {applied && (
        <Alert severity="success">
          {applied.reused
            ? `Build ${applied.buildId} already carries these settings, so nothing was published.`
            : `New deployments run build ${applied.buildId}. Deployments already running keep the settings they started with until they are deployed again.`}
        </Alert>
      )}

      {loading && (
        <Stack alignItems="center" sx={{ py: 5 }}>
          <CircularProgress size={24} />
        </Stack>
      )}

      {settings?.files.map((file) => (
        <SettingsFileCard
          key={file.path}
          file={file}
          draft={draft[file.path]}
          disabled={disabled}
          onEntryChange={(key, value) => setDraft((current) => withEntry(current, file.path, key, value))}
          onEntryRemove={(key) => setDraft((current) => withRemoval(current, file.path, key))}
          onTextChange={(text) => setDraft((current) => withText(current, file.path, text))}
        />
      ))}

      {settings && (
        <SectionCard>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            <Button
              variant="contained"
              size="small"
              disabled={saveDisabled || edits.length === 0}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button
              variant="outlined"
              size="small"
              disabled={saveDisabled || (edits.length === 0 && isCarriedByTheBuild(settings))}
              onClick={() => void saveAndApply()}
            >
              Save and apply
            </Button>
            <Button
              size="small"
              disabled={disabled || edits.length === 0}
              onClick={() => setDraft(draftOf(settings))}
            >
              Discard
            </Button>
            <Box sx={{ flex: '1 1 auto' }} />
            <Typography
              variant="caption"
              color={refusedKeys.length > 0 ? 'error.main' : 'text.secondary'}
            >
              {footerNote(edits, refusedKeys)}
            </Typography>
          </Stack>
        </SectionCard>
      )}
    </Stack>
  );
}
