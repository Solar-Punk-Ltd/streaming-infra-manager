import { FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../app/theme';
import { fieldHint } from './settingsText';

const BOOLEAN_TRUE = 'true';
const BOOLEAN_FALSE = 'false';

/** What an empty choice is called in the list, which differs by whether the stack names it as a choice. */
const EMPTY_CHOICE_LABEL = 'empty';
const UNSET_CHOICE_LABEL = "not set, the stack's own default";

/**
 * The browser is told these fields are not a sign-in form. A password manager
 * that offers to save a token puts it somewhere nobody rotated it from, and
 * one that fills a field changes a setting nobody typed.
 */
const PLAIN_TEXT_INPUT = {
  spellCheck: false,
  autoComplete: 'off',
  autoCapitalize: 'off',
  autoCorrect: 'off',
  style: { fontFamily: MONO_STACK, fontSize: 13 },
} as const;

export function settingFieldId(key: string): string {
  return `deployment-setting-${key}`;
}

interface FieldProps {
  entry: DeploymentSettingEntry;
  value: string;
  disabled: boolean;
  /** Why the manager would refuse this value, shown under the field in place of its hint. */
  problem: string | null;
  onChange: (value: string) => void;
}

/**
 * The input for one key, by what the page knows of its shape: a list for a
 * choice, a switch for a true or false, a number field with its bounds for a
 * number, a masked field for a secret, and plain text for everything else.
 * Every one is labelled by the key, which is the name an operator searches
 * the stack's own documentation by.
 */
export function SettingValueField(props: FieldProps) {
  const { entry } = props;
  if (entry.secret) return <TextInput {...props} masked />;
  if (entry.field?.kind === 'choice') return <ChoiceInput {...props} choices={entry.field.choices ?? []} />;
  if (entry.field?.kind === 'boolean') return <BooleanInput {...props} />;
  return <TextInput {...props} masked={false} />;
}

/**
 * What an empty field says. Empty is a value of its own when the deployment
 * or the version sets it, and the absence of one otherwise.
 */
function placeholderOf(entry: DeploymentSettingEntry, masked: boolean): string {
  if (masked) return 'Type a new value';
  return entry.stored || entry.versionSet ? 'Empty' : 'Not set';
}

function TextInput({ entry, value, disabled, problem, onChange, masked }: FieldProps & { masked: boolean }) {
  const hint = fieldHint(entry.field);
  const numeric = entry.field?.kind === 'integer' || entry.field?.kind === 'number';
  return (
    <TextField
      id={settingFieldId(entry.key)}
      size="small"
      fullWidth
      value={value}
      type={masked ? 'password' : 'text'}
      disabled={disabled}
      placeholder={placeholderOf(entry, masked)}
      error={problem !== null}
      helperText={problem ?? hint ?? undefined}
      onChange={(event) => onChange(event.target.value)}
      inputProps={{
        ...PLAIN_TEXT_INPUT,
        'aria-label': entry.key,
        ...(numeric ? { inputMode: entry.field?.kind === 'integer' ? 'numeric' : 'decimal' } : {}),
      }}
    />
  );
}

function choiceLabel(choice: string, choices: readonly string[]): string {
  if (choice !== '') return choice;
  return choices.includes('') ? EMPTY_CHOICE_LABEL : UNSET_CHOICE_LABEL;
}

/**
 * A native list, which a phone opens as its own picker. The value on file is
 * offered even when it is not one of the stack's choices, so the list shows
 * what is stored rather than silently showing the first choice.
 */
function ChoiceInput({ entry, value, disabled, problem, onChange, choices }: FieldProps & { choices: readonly string[] }) {
  const options = [...new Set(['', ...choices, value])];
  return (
    <TextField
      id={settingFieldId(entry.key)}
      select
      size="small"
      fullWidth
      value={value}
      disabled={disabled}
      error={problem !== null}
      helperText={problem ?? undefined}
      onChange={(event) => onChange(event.target.value)}
      SelectProps={{ native: true }}
      inputProps={{ 'aria-label': entry.key, style: { fontFamily: MONO_STACK, fontSize: 13 } }}
    >
      {options.map((choice) => (
        <option key={choice} value={choice}>
          {choiceLabel(choice, choices)}
        </option>
      ))}
    </TextField>
  );
}

/** What the switch's label reads, which is the value the env file gets. */
function booleanLabel(value: string): string {
  if (value === BOOLEAN_TRUE || value === BOOLEAN_FALSE) return value;
  return value === '' ? "not set, the stack's own default" : `${value}, which is neither true nor false`;
}

function BooleanInput({ entry, value, disabled, problem, onChange }: FieldProps) {
  return (
    <Stack spacing={0.25}>
      <FormControlLabel
        disabled={disabled}
        control={
          <Switch
            id={settingFieldId(entry.key)}
            size="small"
            checked={value === BOOLEAN_TRUE}
            onChange={(event) => onChange(event.target.checked ? BOOLEAN_TRUE : BOOLEAN_FALSE)}
            inputProps={{ 'aria-label': entry.key }}
          />
        }
        label={
          <Typography variant="body2" sx={{ fontFamily: MONO_STACK }}>
            {booleanLabel(value)}
          </Typography>
        }
      />
      {problem && (
        <Typography variant="caption" color="error.main">
          {problem}
        </Typography>
      )}
    </Stack>
  );
}
