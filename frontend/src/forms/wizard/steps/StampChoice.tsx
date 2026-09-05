import { TextField } from '@mui/material';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import type { WizardStepProps } from '../wizardState';

/** Where the postage batch that pays for uploads comes from. */
export function StampChoice({ state, update }: WizardStepProps) {
  return (
    <FormField
      label="Postage stamp"
      aside="prepaid Swarm storage the uploader pays with"
    >
      <ChoiceGroup
        name="wizard-stamp"
        value={state.stampMode}
        onChange={(stampMode) => update({ stampMode })}
        choices={[
          {
            value: 'later',
            title: 'Buy it after deploying',
            detail:
              'Recommended. The node needs funding first. Everything else starts now, the uploader waits for the stamp.',
          },
          {
            value: 'paste',
            title: 'I already have a stamp ID',
            detail: 'From a node that already ran here.',
            extra: (
              <TextField
                size="small"
                fullWidth
                value={state.stampId}
                onChange={(event) => update({ stampId: event.target.value })}
                placeholder="64 hex characters"
                inputProps={{ style: { fontFamily: MONO_STACK } }}
              />
            ),
          },
        ]}
      />
    </FormField>
  );
}
