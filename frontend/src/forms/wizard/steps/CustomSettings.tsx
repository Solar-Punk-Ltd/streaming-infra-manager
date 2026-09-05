import {
  Box,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  CLIENT_SERVICE,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import { SERVICE_DESCRIPTIONS } from '../../../deployments/shape';
import { FormField } from '../../FormField';
import { CUSTOM_COMPONENTS } from '../wizardGoals';
import { needsExternalBeeUrl, type WizardStepProps } from '../wizardState';
import { FeedChoice } from './FeedChoice';
import { PassphraseChoice } from './PassphraseChoice';
import { StampChoice } from './StampChoice';
import { StreamKeyChoice } from './StreamKeyChoice';

const ENGINES: string[] = [SRS_SERVICE, OME_SERVICE];

const ENGINE_HINT = 'srs and ome are both media engines, pick one at most.';

export function CustomSettings(props: WizardStepProps) {
  const { state, update } = props;

  const toggle = (service: string) => {
    const on = state.components.includes(service);
    const kept = on
      ? state.components.filter((entry) => entry !== service)
      : // Picking one engine drops the other, which is the rule the manager
        // enforces and the only pair that cannot both be on.
        [
          ...state.components.filter(
            (entry) => !(ENGINES.includes(service) && ENGINES.includes(entry)),
          ),
          service,
        ];
    update({ components: kept });
  };

  return (
    <Stack spacing={2.5}>
      <FormField label="Components" hint={ENGINE_HINT}>
        <Stack>
          {CUSTOM_COMPONENTS.map((service) => (
            <FormControlLabel
              key={service}
              control={
                <Checkbox
                  size="small"
                  checked={state.components.includes(service)}
                  onChange={() => toggle(service)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2" sx={{ fontFamily: MONO_STACK }}>
                    {service}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {SERVICE_DESCRIPTIONS[service]}
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', mb: 0.5 }}
            />
          ))}
        </Stack>
      </FormField>

      {state.components.includes(SRS_SERVICE) && <PassphraseChoice {...props} />}
      {state.components.includes(STREAM_UPLOADER_SERVICE) && (
        <>
          <StreamKeyChoice {...props} />
          <StampChoice {...props} />
        </>
      )}
      {state.components.includes(CLIENT_SERVICE) && <FeedChoice {...props} />}
      {needsExternalBeeUrl(state) && (
        <FormField
          label="External Bee API"
          aside="optional"
          hint="Without a bee-uploader of its own, the uploader posts to this node."
        >
          <TextField
            size="small"
            fullWidth
            value={state.beeUrl}
            onChange={(event) => update({ beeUrl: event.target.value })}
            placeholder="http://10.0.0.7:1633"
            inputProps={{ style: { fontFamily: MONO_STACK } }}
          />
        </FormField>
      )}
    </Stack>
  );
}
