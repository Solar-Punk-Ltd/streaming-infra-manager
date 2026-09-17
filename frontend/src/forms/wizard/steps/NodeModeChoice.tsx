import { Box, Typography } from '@mui/material';

import {
  LIGHT_NODE_MODE,
  type NodeMode,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import { ChoiceGroup } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { chosenNodeMode, nodeModeQuestion, type WizardStepProps } from '../wizardState';

const LABEL = 'Node mode';

/** What a publishing node is told, because it has no choice to make. */
const REQUIRED_FOR_PUBLISHING = 'Light node, required to publish';

const REQUIRED_DETAIL =
  'A node that uploads pays the peers that carry its data, so it needs the chain on, a chequebook, and gas.';

const ULTRA_LIGHT_DETAIL =
  'Downloads only. No chain, no chequebook and no gas, so there is nothing to fund.';

const LIGHT_DETAIL =
  'Pays for the bandwidth it uses through a chequebook, so it needs gas and an RPC endpoint.';

/**
 * How much of a chain this deployment's Bee node runs with.
 *
 * One question with two shapes. A node that publishes has to have the chain
 * on, so its step says so in a line rather than offering a choice that has one
 * answer. A viewer's gateway is useful either way and is asked, starting on
 * the mode that costs nothing to run.
 */
export function NodeModeChoice({ state, update }: WizardStepProps) {
  const question = nodeModeQuestion(state);
  if (question === 'none') return null;

  if (question === 'line') {
    return (
      <FormField label={LABEL} hint={REQUIRED_DETAIL}>
        <Box
          sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1.25 }}
        >
          <Typography variant="body2" fontWeight={600}>
            {REQUIRED_FOR_PUBLISHING}
          </Typography>
        </Box>
      </FormField>
    );
  }

  return (
    <FormField label={LABEL} labelId="wizard-node-mode-label">
      <ChoiceGroup<NodeMode>
        name="wizard-node-mode"
        labelledBy="wizard-node-mode-label"
        value={chosenNodeMode(state) ?? ULTRA_LIGHT_NODE_MODE}
        onChange={(nodeMode) => update({ nodeMode })}
        choices={[
          {
            value: ULTRA_LIGHT_NODE_MODE,
            title: 'Ultra-light',
            detail: ULTRA_LIGHT_DETAIL,
          },
          { value: LIGHT_NODE_MODE, title: 'Light', detail: LIGHT_DETAIL },
        ]}
      />
    </FormField>
  );
}
