import { MenuItem, Stack, TextField } from '@mui/material';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { poolsIn, poolValueIn, type WizardStepProps } from '../wizardState';
import { PassphraseChoice } from './PassphraseChoice';
import { StreamKeyChoice } from './StreamKeyChoice';

const POOL_PLACEHOLDER =
  '360p@http://host:10015<batch> 480p@… 720p@… 1080p@…';

export function UploaderSettings(props: WizardStepProps) {
  const { state, context, update } = props;
  const pools = poolsIn(context);

  return (
    <Stack spacing={2.5}>
      <FormField label="Node pool to publish to">
        <ChoiceGroup
          name="wizard-pool"
          value={state.poolMode}
          onChange={(poolMode) => update({ poolMode })}
          choices={[
            {
              value: 'pick',
              title: 'A pool on this manager',
              detail: pools.length
                ? 'Its string is filled in for you when the pool is ready.'
                : 'No pools here yet.',
              disabled: pools.length === 0,
              extra: (
                <TextField
                  size="small"
                  fullWidth
                  select
                  value={state.poolId == null ? '' : String(state.poolId)}
                  onChange={(event) => update({ poolId: Number(event.target.value) })}
                >
                  {pools.map((pool) => {
                    const ready = poolValueIn(context, pool.id) !== null;
                    return (
                      <MenuItem key={pool.id} value={String(pool.id)} disabled={!ready}>
                        {pool.name}
                        {ready ? '' : ' · not ready yet'}
                      </MenuItem>
                    );
                  })}
                </TextField>
              ),
            },
            {
              value: 'paste',
              title: 'A pool on another manager',
              detail: 'Paste the pool string copied from its pool page.',
              extra: (
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  minRows={2}
                  value={state.poolString}
                  onChange={(event) => update({ poolString: event.target.value })}
                  placeholder={POOL_PLACEHOLDER}
                  inputProps={{ style: { fontFamily: MONO_STACK } }}
                />
              ),
            },
          ]}
        />
      </FormField>

      <PassphraseChoice {...props} />
      <StreamKeyChoice {...props} />
    </Stack>
  );
}
