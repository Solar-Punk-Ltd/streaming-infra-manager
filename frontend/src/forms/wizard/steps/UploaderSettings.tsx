import { Alert, Button, MenuItem, Stack, TextField } from '@mui/material';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField, messageIdFor } from '../../FormField';
import { poolStringError } from '../wizardError';
import { poolsIn, poolValueIn, type WizardStepProps } from '../wizardState';
import { PassphraseChoice } from './PassphraseChoice';
import { StreamKeyChoice } from './StreamKeyChoice';
import { PoolPrerequisites } from './PoolPrerequisites';

const POOL_PLACEHOLDER =
  '360p@http://host:10015<batch> 480p@… 720p@… 1080p@…';

export function UploaderSettings(props: WizardStepProps) {
  const { state, context, update, onCreatePool } = props;
  const pools = poolsIn(context);
  const poolFieldError =
    state.poolMode === 'paste' ? poolStringError(state.poolString) : null;

  return (
    <Stack spacing={2.5}>
      {pools.length === 0 && <Alert severity="info">An ABR uploader needs one Bee storage node for each quality level. Create a storage pool here, or use a pool from another manager. Your uploader draft stays here while you create a pool.</Alert>}
      {onCreatePool && <Button variant="outlined" onClick={onCreatePool}>Create a storage pool</Button>}
      <FormField
        label="Node pool to publish to"
        labelId="wizard-pool-label"
        error={poolFieldError}
        messageId={messageIdFor('wizard-pool-string')}
      >
        <ChoiceGroup
          name="wizard-pool"
          labelledBy="wizard-pool-label"
          value={state.poolMode}
          onChange={(poolMode) => update({ poolMode })}
          choices={[
            {
              value: 'pick',
              title: 'A pool on this manager',
              detail: pools.length
                ? 'Choose a pool and check its nodes below. Its endpoints and stamp ids supply the configuration.'
                : 'No pools here yet.',
              disabled: pools.length === 0,
              extra: (
                <TextField
                  size="small"
                  fullWidth
                  select
                  value={state.poolId == null ? '' : String(state.poolId)}
                  SelectProps={{ SelectDisplayProps: { 'aria-label': 'Storage pool' } }}
                  onChange={(event) => update({ poolId: Number(event.target.value) })}
                >
                  {pools.map((pool) => {
                    const ready = poolValueIn(context, pool.id) !== null;
                    return (
                      <MenuItem key={pool.id} value={String(pool.id)}>
                        {pool.name}
                        {ready ? '' : ' · configuration incomplete'}
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
                  id="wizard-pool-string"
                  size="small"
                  fullWidth
                  multiline
                  minRows={2}
                  error={poolFieldError !== null}
                  value={state.poolString}
                  onChange={(event) => update({ poolString: event.target.value })}
                  placeholder={POOL_PLACEHOLDER}
                  inputProps={{
                    style: { fontFamily: MONO_STACK },
                    'aria-label': 'Pool string',
                    'aria-describedby': messageIdFor('wizard-pool-string'),
                  }}
                />
              ),
            },
          ]}
        />
      </FormField>

      {state.poolMode === 'pick' && state.poolId !== null && <PoolPrerequisites key={state.poolId} poolId={state.poolId} context={context} />}

      <PassphraseChoice {...props} />
      <StreamKeyChoice {...props} />
    </Stack>
  );
}
