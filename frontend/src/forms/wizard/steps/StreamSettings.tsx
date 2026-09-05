import { Stack, TextField } from '@mui/material';

import { OME_SERVICE, SRS_SERVICE } from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import type { WizardStepProps } from '../wizardState';
import { PassphraseChoice } from './PassphraseChoice';
import { StampChoice } from './StampChoice';
import { StreamKeyChoice } from './StreamKeyChoice';

export function StreamSettings(props: WizardStepProps) {
  const { state, update } = props;

  return (
    <Stack spacing={2.5}>
      <FormField label="Media engine">
        <ChoiceGroup
          name="wizard-engine"
          value={state.engine}
          onChange={(engine) => update({ engine })}
          choices={[
            {
              value: SRS_SERVICE,
              title: 'SRS',
              detail: 'Default. SRT ingest with passphrase support.',
            },
            {
              value: OME_SERVICE,
              title: 'OvenMediaEngine',
              detail: 'Alternative engine. Its SRT listener takes no passphrase.',
            },
          ]}
        />
      </FormField>

      {state.engine === SRS_SERVICE && <PassphraseChoice {...props} />}

      <StreamKeyChoice {...props} />

      <StampChoice {...props} />

      {!state.group && (
        <FormField label="Bee node">
          <ChoiceGroup
            name="wizard-bee"
            value={state.beeMode}
            onChange={(beeMode) => update({ beeMode })}
            choices={[
              {
                value: 'own',
                title: 'Run its own Bee node',
                detail:
                  'Default. One node per stream, funded and stamped from this manager.',
              },
              {
                value: 'external',
                title: 'Use an external Bee API',
                detail: 'No node is started here.',
                extra: (
                  <TextField
                    size="small"
                    fullWidth
                    value={state.beeUrl}
                    onChange={(event) => update({ beeUrl: event.target.value })}
                    placeholder="http://10.0.0.7:1633"
                    inputProps={{ style: { fontFamily: MONO_STACK } }}
                  />
                ),
              },
            ]}
          />
        </FormField>
      )}
    </Stack>
  );
}
