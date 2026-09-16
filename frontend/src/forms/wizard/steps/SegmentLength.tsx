import { TextField } from '@mui/material';

import { FormField, messageIdFor } from '../../FormField';
import { SEGMENT_LENGTH_FIELD, segmentLengthError } from '../segmentLength';
import type { WizardStepProps } from '../wizardState';

const FIELD_ID = 'wizard-segment-length';

/**
 * The segment length question, for every goal that runs the SRS engine.
 *
 * Prefilled rather than blank, because a deployment that stores nothing runs on
 * whatever its stack version falls back to, and on main-v3 that is half a
 * second. Clearing the field is still allowed and means exactly that.
 */
export function SegmentLength({ state, update }: WizardStepProps) {
  const error = segmentLengthError(state.segmentSeconds);

  return (
    <FormField
      label={SEGMENT_LENGTH_FIELD.label}
      aside={SEGMENT_LENGTH_FIELD.unit ?? undefined}
      hint={SEGMENT_LENGTH_FIELD.help}
      error={error}
      htmlFor={FIELD_ID}
    >
      <TextField
        id={FIELD_ID}
        size="small"
        error={error !== null}
        value={state.segmentSeconds}
        onChange={(event) => update({ segmentSeconds: event.target.value })}
        placeholder={SEGMENT_LENGTH_FIELD.defaultValue}
        inputProps={{
          inputMode: 'decimal',
          'aria-describedby': messageIdFor(FIELD_ID),
        }}
      />
    </FormField>
  );
}
