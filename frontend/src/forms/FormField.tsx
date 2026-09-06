import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * One question in a form: a label, an optional aside on the same line, the
 * control, and a hint or an error underneath.
 */
export function FormField({
  label,
  aside,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  aside?: string;
  hint?: ReactNode;
  error?: string | null;
  /**
   * The id of the control this label names. Given one, the label is a real
   * label: clicking it focuses the input, and a screen reader reads the two
   * together instead of announcing an unnamed text box.
   */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <Box>
      <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2" component="label" htmlFor={htmlFor}>
          {label}
        </Typography>
        {aside && (
          <Typography variant="caption" color="text.secondary">
            {aside}
          </Typography>
        )}
      </Stack>
      {children}
      {error ? (
        <Typography variant="caption" color="warning.main" sx={{ mt: 0.75, display: 'block' }}>
          {error}
        </Typography>
      ) : (
        hint && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
            {hint}
          </Typography>
        )
      )}
    </Box>
  );
}
