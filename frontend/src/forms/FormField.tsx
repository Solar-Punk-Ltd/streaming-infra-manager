import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * The id of the hint or error under the control `htmlFor` names. A control
 * that points `aria-describedby` at it has its hint or error read out with
 * it, instead of the message sitting on screen unannounced.
 */
export function messageIdFor(htmlFor: string): string {
  return `${htmlFor}-message`;
}

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
  messageId: givenMessageId,
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
  /**
   * The id the hint or error is rendered under, for a control that is not the
   * one the label names, such as a field inside a choice. Derived from
   * `htmlFor` when left out.
   */
  messageId?: string;
  children: ReactNode;
}) {
  const messageId = givenMessageId ?? (htmlFor ? messageIdFor(htmlFor) : undefined);
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
        <Typography
          id={messageId}
          variant="caption"
          color="warning.main"
          aria-live="polite"
          sx={{ mt: 0.75, display: 'block' }}
        >
          {error}
        </Typography>
      ) : (
        hint && (
          <Typography
            id={messageId}
            variant="caption"
            color="text.secondary"
            sx={{ mt: 0.75, display: 'block' }}
          >
            {hint}
          </Typography>
        )
      )}
    </Box>
  );
}
