import { Box, Button, Stack, Typography } from '@mui/material';

import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import { toneBannerStyles, toneMainColor, type Tone } from '../components/tone';
import type { ChecklistStep, StepAction, StepState } from './checklist';
import type { ReadySummary } from './readySummary';

const STEP_TONE: Record<StepState, Tone> = {
  ok: 'ok',
  warn: 'warn',
  err: 'err',
  busy: 'info',
  off: 'gray',
};

const STEP_GLYPH: Record<StepState, string> = {
  ok: '✓',
  warn: '!',
  err: '!',
  busy: '…',
  off: '',
};

export function ReadinessCard({
  steps,
  summary,
  onAction,
}: {
  steps: ChecklistStep[];
  summary: ReadySummary;
  onAction: (action: StepAction) => void;
}) {
  const done = steps.filter((step) => step.state === 'ok').length;

  return (
    <SectionCard
      title="Readiness"
      sub={`${done} of ${steps.length} steps done`}
      flush
    >
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {steps.map((step, index) => {
          const action = step.action;
          return (
            <Stack
              key={step.title}
              component="li"
              direction="row"
              spacing={1.5}
              alignItems="center"
              sx={{
                px: 2.25,
                py: 1.5,
                borderTop: index === 0 ? 0 : 1,
                borderColor: 'divider',
              }}
            >
              <Box
                sx={(theme) => ({
                  width: 22,
                  height: 22,
                  flex: 'none',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: theme.vars.palette.common.white,
                  backgroundColor: toneMainColor(theme, STEP_TONE[step.state]),
                })}
              >
                {STEP_GLYPH[step.state]}
              </Box>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500 }}>{step.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {step.detail}
                </Typography>
              </Box>
              {action && (
                <Button
                  size="small"
                  variant={action.primary ? 'contained' : 'outlined'}
                  onClick={() => onAction(action)}
                  sx={{ flex: 'none' }}
                >
                  {action.label}
                </Button>
              )}
            </Stack>
          );
        })}
      </Box>

      <Stack
        spacing={1}
        sx={(theme) => ({
          ...toneBannerStyles(theme, summary.tone),
          px: 2.25,
          py: 1.75,
          borderTop: 1,
        })}
      >
        <Typography sx={{ fontWeight: 600 }}>{summary.title}</Typography>
        {summary.url && (
          <CopyBox
            value={summary.url}
            href={summary.isLink ? summary.url : undefined}
          />
        )}
      </Stack>
    </SectionCard>
  );
}
