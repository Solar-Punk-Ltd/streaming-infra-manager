import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { takesValue } from './deploymentSettingsDraft';
import type { SettingRowState } from './DeploymentSettingRow';
import {
  newDeploymentSettingsOf,
  type NewDeploymentSettingValues,
  newValueProblems,
  valuesNotTaken,
  withNewValue,
  withoutNewValue,
} from './newDeploymentSettingsDraft';
import { SettingsList } from './SettingsList';
import { NEW_DEPLOYMENT_SETTINGS_LEAD, newDeploymentSettingsNote, notTakenNote } from './settingsText';
import type { NewDeploymentSettingsLoad } from './useNewDeploymentSettings';

const USE_VERSION_VALUES = "Use the version's values";

/** Where every key stands against the typed values, by key. Nothing runs yet, so nothing is behind. */
function rowStatesOf(
  entries: readonly DeploymentSettingEntry[],
  values: NewDeploymentSettingValues,
): Map<string, SettingRowState> {
  const sent = new Set(newDeploymentSettingsOf(entries, values).map(({ key }) => key));
  const problems = newValueProblems(entries, values);
  return new Map(
    entries.map((entry) => {
      const typed = values[entry.key];
      return [
        entry.key,
        {
          edit: typed !== undefined && takesValue(entry) ? { kind: 'value', value: typed } : undefined,
          pending: sent.has(entry.key),
          behind: false,
          problem: problems[entry.key] ?? null,
        },
      ];
    }),
  );
}

/**
 * The settings editor of the new-deployment wizard: the same list, rows and
 * fields as a deployment's own page, for a deployment that does not exist
 * yet. There is nothing stored, so no banner, no Apply, no revision and no
 * Save: the wizard's Deploy sends what was typed, and taking a value back out
 * is the whole of going back to the version's value.
 */
export function NewDeploymentSettingsEditor({
  load,
  values,
  controlValues,
  onChange,
}: {
  /** The list for the choices on screen, or undefined where nothing asked for it yet. */
  load: NewDeploymentSettingsLoad | undefined;
  values: NewDeploymentSettingValues;
  /** What the wizard's own fields give the keys a control decides, by key. */
  controlValues: Readonly<Record<string, string>>;
  onChange: (values: NewDeploymentSettingValues) => void;
}) {
  const typed = Object.keys(values).length > 0;
  const catalog = load?.catalog ?? null;

  if (!catalog) {
    if (!load?.failure) {
      return (
        <Stack alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size={24} aria-label="Reading the settings" />
        </Stack>
      );
    }
    return (
      <Alert
        severity={load.failure.severity}
        sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
        action={
          <Stack spacing={0.5} alignItems="flex-end">
            <Button color="inherit" size="small" onClick={() => void load.reload()}>
              Try again
            </Button>
            {typed && (
              <Button color="inherit" size="small" onClick={() => onChange({})}>
                {USE_VERSION_VALUES}
              </Button>
            )}
          </Stack>
        }
      >
        {load.failure.message}
      </Alert>
    );
  }

  const { entries } = catalog;
  const sent = newDeploymentSettingsOf(entries, values);
  const refused = Object.keys(newValueProblems(entries, values));
  const notTaken = valuesNotTaken(entries, values);

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">
        {NEW_DEPLOYMENT_SETTINGS_LEAD}
      </Typography>

      {notTaken.length > 0 && (
        <Alert severity="info" sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
          {notTakenNote(notTaken)}
        </Alert>
      )}

      <SettingsList
        entries={entries}
        states={rowStatesOf(entries, values)}
        running={false}
        disabled={false}
        target="new-deployment"
        controlValues={controlValues}
        onValue={(key, value) => onChange(withNewValue(values, entries, key, value))}
        onReset={(key) => onChange(withoutNewValue(values, key))}
        onUndo={(key) => onChange(withoutNewValue(values, key))}
      />

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Button size="small" disabled={!typed} onClick={() => onChange({})}>
          {USE_VERSION_VALUES}
        </Button>
        <Box sx={{ flex: '1 1 auto' }} />
        <Typography
          variant="caption"
          color={refused.length > 0 ? 'error.main' : 'text.secondary'}
          sx={{ overflowWrap: 'anywhere' }}
        >
          {newDeploymentSettingsNote(sent.length, refused)}
        </Typography>
      </Stack>
    </Stack>
  );
}
