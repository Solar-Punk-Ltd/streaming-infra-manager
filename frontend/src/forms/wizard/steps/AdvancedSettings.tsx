import { useId, useState } from 'react';
import { Box, ButtonBase, Collapse, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { NewDeploymentSettingsEditor } from '../../../deployments/settings/NewDeploymentSettingsEditor';
import { advancedSettingsFoldLine, controlValuesOf } from '../advancedSettings';
import type { WizardStepProps } from '../wizardState';

/**
 * Every key the chosen version declares, for the deployment about to be
 * created, under the goal's own fields and folded until opened, because most
 * deployments keep every version value. It opens by itself when values were
 * typed on an earlier visit, so a return from the review finds them.
 */
export function AdvancedSettings({ state, context, update }: WizardStepProps) {
  const [open, setOpen] = useState(() => Object.keys(state.stackSettings).length > 0);
  const regionId = useId();

  return (
    <Box component="section" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, minWidth: 0 }}>
      <Typography variant="subtitle2" component="h4" sx={{ m: 0 }}>
        <ButtonBase
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((was) => !was)}
          sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', px: 1.5, py: 1.25, gap: 1, borderRadius: 2 }}
        >
          <ExpandMoreIcon
            fontSize="small"
            sx={{ flex: 'none', transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }}
          />
          <Stack component="span" sx={{ minWidth: 0 }}>
            <Box component="span" sx={{ fontWeight: 600 }}>
              Advanced settings
            </Box>
            <Typography component="span" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {advancedSettingsFoldLine(state, context)}
            </Typography>
          </Stack>
        </ButtonBase>
      </Typography>
      <Collapse in={open} unmountOnExit>
        <Box id={regionId} sx={{ px: 1.5, pb: 1.5, minWidth: 0 }}>
          <NewDeploymentSettingsEditor
            load={context.newDeploymentSettings}
            values={state.stackSettings}
            controlValues={controlValuesOf(state)}
            onChange={(stackSettings) => update({ stackSettings })}
          />
        </Box>
      </Collapse>
    </Box>
  );
}
