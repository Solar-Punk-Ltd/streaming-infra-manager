import { MenuItem, TextField } from '@mui/material';

import { MONO_STACK } from '../../../app/theme';
import { shortHex } from '../../../format';
import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { streamsIn, type WizardStepProps } from '../wizardState';

/** Which streamer's feed a player follows. */
export function FeedChoice({ state, context, update }: WizardStepProps) {
  const streams = streamsIn(context);

  return (
    <FormField label="Stream to follow">
      <ChoiceGroup
        name="wizard-feed"
        value={state.feedMode}
        onChange={(feedMode) => update({ feedMode })}
        choices={[
          {
            value: 'pick',
            title: 'A stream on this manager',
            detail: streams.length
              ? 'Its address is filled in for you.'
              : 'No streams here yet.',
            disabled: streams.length === 0,
            extra: (
              <TextField
                size="small"
                fullWidth
                select
                value={state.feedStreamer}
                onChange={(event) => update({ feedStreamer: event.target.value })}
              >
                {streams.map((stream) => (
                  <MenuItem key={stream.name} value={stream.name}>
                    {stream.name} · {shortHex(stream.public_key ?? '')}
                  </MenuItem>
                ))}
              </TextField>
            ),
          },
          {
            value: 'paste',
            title: 'A streamer somewhere else',
            detail: 'Paste its public address.',
            extra: (
              <TextField
                size="small"
                fullWidth
                value={state.feedOwner}
                onChange={(event) => update({ feedOwner: event.target.value })}
                placeholder="0x plus 40 hex characters"
                inputProps={{ style: { fontFamily: MONO_STACK } }}
              />
            ),
          },
        ]}
      />
    </FormField>
  );
}
