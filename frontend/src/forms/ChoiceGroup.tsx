import { Box, Radio, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export interface Choice<T extends string> {
  value: T;
  title: string;
  detail?: ReactNode;
  /** Shown under the title only while this choice is the selected one. */
  extra?: ReactNode;
  disabled?: boolean;
}

/**
 * A list of radio cards: one line of plain words each, with the fields that
 * choice needs appearing underneath it once it is picked.
 *
 * Every either-or in the wizard and the drawers reads this way, so the fields
 * that belong to an option can never be on screen while another option is
 * selected.
 */
export function ChoiceGroup<T extends string>({
  name,
  value,
  choices,
  onChange,
}: {
  /** Groups the radios, so arrow keys move within one question. */
  name: string;
  value: T;
  choices: Choice<T>[];
  onChange: (next: T) => void;
}) {
  return (
    <Stack spacing={1}>
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Box
            key={choice.value}
            sx={{
              border: 1,
              borderColor: selected ? 'primary.main' : 'divider',
              borderRadius: 2,
              px: 1.5,
              py: 1.25,
              opacity: choice.disabled ? 0.55 : 1,
              bgcolor: selected ? 'action.hover' : 'transparent',
            }}
          >
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Radio
                size="small"
                name={name}
                value={choice.value}
                checked={selected}
                disabled={choice.disabled}
                onChange={() => onChange(choice.value)}
                sx={{ p: 0.25, mt: 0.125 }}
                inputProps={{ 'aria-label': choice.title }}
              />
              <Box
                onClick={() => {
                  if (!choice.disabled) onChange(choice.value);
                }}
                sx={{ flex: 1, cursor: choice.disabled ? 'default' : 'pointer' }}
              >
                <Typography variant="body2" fontWeight={600}>
                  {choice.title}
                </Typography>
                {choice.detail && (
                  <Typography variant="caption" color="text.secondary" component="div">
                    {choice.detail}
                  </Typography>
                )}
              </Box>
            </Stack>
            {selected && choice.extra && (
              <Box sx={{ mt: 1.25, pl: 3.5 }} onClick={(e) => e.stopPropagation()}>
                {choice.extra}
              </Box>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
