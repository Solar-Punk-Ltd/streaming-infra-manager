import { Box, Paper, Stack, Typography } from '@mui/material';
import GridViewIcon from '@mui/icons-material/GridView';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TuneIcon from '@mui/icons-material/Tune';
import VisibilityIcon from '@mui/icons-material/Visibility';
import WavesIcon from '@mui/icons-material/Waves';
import type { ReactNode } from 'react';

import { ServiceChip } from '../../../components/ServiceChip';
import { GOALS } from '../wizardGoals';
import type { WizardGoal, WizardStepProps } from '../wizardState';

const GOAL_ICONS: Record<WizardGoal, ReactNode> = {
  stream: <PlayArrowIcon fontSize="small" />,
  viewer: <VisibilityIcon fontSize="small" />,
  'abr-pool': <GridViewIcon fontSize="small" />,
  'abr-uploader': <WavesIcon fontSize="small" />,
  custom: <TuneIcon fontSize="small" />,
};

export function GoalStep({ state, update }: WizardStepProps) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6" component="h4">
          What do you want to set up?
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Only the settings that matter for your choice will be asked.
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 1.5,
        }}
      >
        {GOALS.map((goal) => {
          const selected = state.goal === goal.id;
          return (
            <Paper
              key={goal.id}
              onClick={() => update({ goal: goal.id })}
              sx={{
                p: 1.75,
                cursor: 'pointer',
                borderColor: selected ? 'primary.main' : 'divider',
                bgcolor: selected ? 'action.hover' : 'background.paper',
                gridColumn: goal.id === 'custom' ? { sm: 'span 2' } : undefined,
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Box sx={{ color: 'primary.main', mt: 0.25 }}>
                  {GOAL_ICONS[goal.id]}
                </Box>
                <Box>
                  <Typography variant="subtitle2">{goal.title}</Typography>
                  <Typography variant="caption" color="text.secondary" component="p">
                    {goal.detail}
                  </Typography>
                  {goal.services.length > 0 && (
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }} flexWrap="wrap">
                      {goal.services.map((service) => (
                        <ServiceChip key={service} service={service} />
                      ))}
                    </Stack>
                  )}
                </Box>
              </Stack>
            </Paper>
          );
        })}
      </Box>
    </Stack>
  );
}
