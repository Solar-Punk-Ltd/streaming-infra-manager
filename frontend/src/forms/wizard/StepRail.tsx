import { Box, Stack, Typography } from '@mui/material';

import { WIZARD_STEPS } from './wizardState';

/** The four steps down the left of the dialog, with the done ones ticked. */
export function StepRail({ step }: { step: number }) {
  return (
    <Stack
      component="ol"
      spacing={1}
      sx={{ listStyle: 'none', m: 0, p: 0, width: { sm: 180 }, flex: 'none' }}
    >
      {WIZARD_STEPS.map((label, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <Stack
            key={label}
            component="li"
            direction="row"
            spacing={1}
            alignItems="center"
          >
            <Box
              sx={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: '0.75rem',
                flex: 'none',
                bgcolor: current || done ? 'primary.main' : 'action.hover',
                color: current || done ? 'primary.contrastText' : 'text.secondary',
              }}
            >
              {done ? '✓' : number}
            </Box>
            <Typography
              variant="body2"
              color={current ? 'text.primary' : 'text.secondary'}
              fontWeight={current ? 600 : 400}
            >
              {label}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}
