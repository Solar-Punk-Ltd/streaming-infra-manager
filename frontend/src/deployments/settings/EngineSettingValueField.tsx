import { InputAdornment, TextField } from '@mui/material';

import type { DeploymentSettingEntry, EngineSettingField } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../app/theme';
import { engineFieldLabelledBy, settingFieldId } from './settingFieldIds';
import { PLAIN_TEXT_INPUT } from './SettingValueField';
import { engineFieldHint } from './settingsText';

interface EngineFieldProps {
  entry: DeploymentSettingEntry;
  /** The field in common's list that the key names, which says what it takes. */
  field: EngineSettingField;
  value: string;
  disabled: boolean;
  /** Why the manager would refuse this value, shown under the field in place of its hint. */
  problem: string | null;
  onChange: (value: string) => void;
}

/** The line under the field is where a refusal appears, so it is read out as it changes. */
const ANNOUNCED_HELPER = { 'aria-live': 'polite' } as const;

/**
 * The input for one of the deployment's engine settings, shaped by common's
 * field: a list of its choices, or a number field with its unit beside it and
 * its bounds under it. Named by the label and the key its row shows, and
 * described by the line under it, which says the unit, since the unit beside
 * the field is drawn and not read out.
 */
export function EngineSettingValueField(props: EngineFieldProps) {
  return props.field.kind === 'choice' ? <EngineChoiceInput {...props} /> : <EngineNumberInput {...props} />;
}

function EngineNumberInput({ entry, field, value, disabled, problem, onChange }: EngineFieldProps) {
  return (
    <TextField
      id={settingFieldId(entry.key)}
      size="small"
      fullWidth
      value={value}
      disabled={disabled}
      error={problem !== null}
      helperText={problem ?? engineFieldHint(field) ?? undefined}
      FormHelperTextProps={ANNOUNCED_HELPER}
      onChange={(event) => onChange(event.target.value)}
      InputProps={field.unit ? { endAdornment: <InputAdornment position="end">{field.unit}</InputAdornment> } : undefined}
      inputProps={{
        ...PLAIN_TEXT_INPUT,
        'aria-labelledby': engineFieldLabelledBy(entry.key),
        inputMode: field.kind === 'integer' ? 'numeric' : 'decimal',
      }}
    />
  );
}

/**
 * A native list of the field's choices, which a phone opens as its own picker.
 * The value on file is offered even when it is not one of them, so the list
 * shows what is stored rather than silently showing the first choice.
 */
function EngineChoiceInput({ entry, field, value, disabled, problem, onChange }: EngineFieldProps) {
  const options = [...new Set([...(field.choices ?? []), value])].filter((choice) => choice !== '');
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
      FormHelperTextProps={ANNOUNCED_HELPER}
      onChange={(event) => onChange(event.target.value)}
      SelectProps={{ native: true }}
      inputProps={{ 'aria-labelledby': engineFieldLabelledBy(entry.key), style: { fontFamily: MONO_STACK, fontSize: 13 } }}
    >
      {options.map((choice) => (
        <option key={choice} value={choice}>
          {choice}
        </option>
      ))}
    </TextField>
  );
}
