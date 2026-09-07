import { useEffect, useState } from 'react';
import {
  Alert,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  type EngineDefaultSource,
  type EngineSettingField,
  type EngineSettings,
  engineSettingFieldProblem,
  engineSettingsProblem,
  getErrorMessage,
} from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';
import {
  fetchEngine,
  saveEngineSettings,
  type EngineOverview,
} from '../deployments/engineApi';
import { ENGINE_LABEL } from '../deployments/engineText';
import { EditDrawerFrame } from './EditDrawerFrame';
import { FormField } from './FormField';

const SAVE_LABEL = 'Apply and recreate engine';

const ABR_SECTION_TITLE = 'Transcoding';

/**
 * How long a value has to stand still before its own error is shown.
 *
 * Typing `12` on the way to `120` is not a mistake, and a message that appears
 * under the input on the first keystroke reads as one. Leaving the field says
 * the same thing sooner, so blur shows it too.
 */
const SETTLE_MS = 600;

const ABR_SECTION_HINT =
  'These apply to every rung of the ABR ladder. They are read only by a deployment that encodes one.';

const NOT_IN_CONFIG =
  'Not read: the config file this deployment runs on dropped the placeholder for it. Put the token back in the file, or set the value there.';

function whatSavingDoes(engineName: string): string {
  return `Recreates the ${engineName} container with the new values. A live publisher is disconnected for a few seconds and reconnects on its own if OBS is set to retry.`;
}

/** Blank means "use the stack default", so the key is simply not stored. */
function storedSettings(edits: EngineSettings): EngineSettings {
  const settings: EngineSettings = {};
  for (const [key, value] of Object.entries(edits)) {
    const trimmed = value.trim();
    if (trimmed) settings[key] = trimmed;
  }
  return settings;
}

function isSameSettings(a: EngineSettings, b: EngineSettings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

/**
 * What is stored for the fields this drawer puts on screen, and nothing else.
 *
 * A deployment that has left the state a setting was stored under still carries
 * it: turn the ABR ladder off and the rung settings stay in the column with no
 * input rendering them. Editing from the whole stored object would put those
 * keys in every save, which the manager refuses, with the message naming a
 * field the operator cannot see and Save greyed out for good.
 */
function renderedSettings(overview: EngineOverview): EngineSettings {
  const rendered: EngineSettings = {};
  for (const field of overview.fields) {
    const value = overview.settings[field.key];
    if (value !== undefined) rendered[field.key] = value;
  }
  return rendered;
}

/**
 * The engine's own settings, in the same frame the Edit drawer uses.
 *
 * Every field comes from the shared list, so what is on screen is what the
 * stack reads, with the stack's own default in the placeholder and its own
 * explanation underneath. Saving recreates one container, which is why the
 * button says so.
 */
export function EngineSettingsDrawer({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { mergeProfiles } = useDeployments();
  const [overview, setOverview] = useState<EngineOverview | null>(null);
  const [edits, setEdits] = useState<EngineSettings>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchEngine(name)
      .then((loaded) => {
        if (!current) return;
        setOverview(loaded);
        setEdits(renderedSettings(loaded));
      })
      .catch((caught) => {
        if (current) setError(getErrorMessage(caught, 'could not read the engine settings'));
      });
    return () => {
      current = false;
    };
  }, [name]);

  const settings = storedSettings(edits);
  const problem = overview
    ? engineSettingsProblem(overview.engine, settings, {
        abr: overview.abr,
        defaults: overview.defaults,
      })
    : null;
  const unchanged = overview
    ? isSameSettings(settings, renderedSettings(overview))
    : true;

  const save = async () => {
    if (!overview) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveEngineSettings(name, settings);
      mergeProfiles([saved]);
      onClose();
      toast(`Saved. Recreating the engine for ${name}…`);
    } catch (caught) {
      setError(getErrorMessage(caught, 'failed to save the engine settings'));
    } finally {
      setSaving(false);
    }
  };

  const engineName = overview ? ENGINE_LABEL[overview.engine] : 'engine';
  const plainFields = overview?.fields.filter((field) => !field.abrOnly) ?? [];
  const abrFields = overview?.fields.filter((field) => field.abrOnly) ?? [];

  return (
    <EditDrawerFrame
      title={`Engine settings for ${name}`}
      saving={saving}
      error={error}
      saveDisabled={!overview || problem !== null || unchanged}
      saveLabel={SAVE_LABEL}
      onSave={() => void save()}
      onClose={onClose}
    >
      {!overview ? (
        <Stack alignItems="center" sx={{ py: 6 }}>
          <CircularProgress />
        </Stack>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {whatSavingDoes(engineName)}
          </Typography>

          {plainFields.map((field) => (
            <SettingField
              key={field.key}
              field={field}
              overview={overview}
              value={edits[field.key] ?? ''}
              onChange={(value) =>
                setEdits((prev) => ({ ...prev, [field.key]: value }))
              }
            />
          ))}

          {abrFields.length > 0 && (
            <Stack spacing={2.5}>
              <Stack spacing={0.5}>
                <Typography variant="subtitle2">{ABR_SECTION_TITLE}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {ABR_SECTION_HINT}
                </Typography>
              </Stack>
              {abrFields.map((field) => (
                <SettingField
                  key={field.key}
                  field={field}
                  overview={overview}
                  value={edits[field.key] ?? ''}
                  onChange={(value) =>
                    setEdits((prev) => ({ ...prev, [field.key]: value }))
                  }
                />
              ))}
            </Stack>
          )}

          {problem && <Alert severity="warning">{problem}</Alert>}
        </>
      )}
    </EditDrawerFrame>
  );
}

/**
 * What an empty field falls back to, and where that value comes from.
 *
 * A host whose base `.env` already sets the key runs that value, because
 * `.env.<profile>` is a copy of it and an unset key is left out. Naming the
 * stack's own number there would describe a container nobody is running.
 */
function defaultLabel(
  value: string,
  source: EngineDefaultSource,
  unit: string,
): string {
  return source === 'host'
    ? `Default ${value}${unit}, set on this host`
    : `Stack default ${value}${unit}`;
}

function SettingField({
  field,
  overview,
  value,
  onChange,
}: {
  field: EngineSettingField;
  overview: EngineOverview;
  value: string;
  onChange: (value: string) => void;
}) {
  const [blurred, setBlurred] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const inputId = `engine-setting-${field.key}`;
  const unit = field.unit ? ` ${field.unit}` : '';
  const fallback = overview.defaults[field.key] ?? field.defaultValue;
  const source = overview.defaultSources[field.key] ?? 'stack';
  const defaultNote =
    `${defaultLabel(fallback, source, unit)}. Leave it empty to use it. ` +
    'Check the effective config under Logs to see what the container is running.';
  const notInConfig = overview.notInConfig.includes(field.key);

  // Shown late, but Save is not gated on it: the drawer's own check runs over
  // every field on every keystroke and is what decides whether Save is live.
  const problem = value.trim() ? engineSettingFieldProblem(field, value) : null;

  return (
    <FormField
      label={field.label}
      aside={field.unit ?? undefined}
      hint={notInConfig ? `${NOT_IN_CONFIG} ${field.help}` : `${field.help} ${defaultNote}`}
      error={blurred || settled ? problem : null}
      htmlFor={inputId}
    >
      {field.choices ? (
        <TextField
          select
          size="small"
          fullWidth
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setBlurred(true)}
          // A select's own id goes on the hidden native input, so the id the
          // label points at has to be put on the element that takes the focus.
          SelectProps={{
            'aria-label': field.label,
            SelectDisplayProps: { id: inputId },
          }}
        >
          <MenuItem value="">{defaultLabel(fallback, source, '')}</MenuItem>
          {field.choices.map((choice) => (
            <MenuItem key={choice} value={choice}>
              {choice}
            </MenuItem>
          ))}
        </TextField>
      ) : (
        <TextField
          id={inputId}
          size="small"
          fullWidth
          value={value}
          placeholder={fallback}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setBlurred(true)}
          inputProps={{ inputMode: 'decimal', 'aria-label': field.label }}
        />
      )}
    </FormField>
  );
}
