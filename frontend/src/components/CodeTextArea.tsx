import { useRef, type ChangeEvent, type UIEvent } from 'react';
import { Box, useTheme } from '@mui/material';

import { MONO_STACK } from '../app/theme';

const GUTTER_WIDTH = 48;
const LINE_HEIGHT = 1.5;
const FONT_SIZE = 13;

/**
 * A plain text area for a whole file, with a line number beside every line.
 *
 * A plain textarea and no editor library, on purpose: an operator pastes a
 * config in, fixes a line the engine named, and applies. The gutter is a
 * second column that follows the textarea's own scrolling, so the numbers
 * stay against their lines however long the file is.
 */
export function CodeTextArea({
  value,
  onChange,
  readOnly = false,
  minHeight = 420,
  ariaLabel,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  minHeight?: number;
  ariaLabel: string;
}) {
  const theme = useTheme();
  const gutter = useRef<HTMLPreElement>(null);
  const lineCount = Math.max(1, value.split('\n').length);
  const numbers = Array.from({ length: lineCount }, (_line, index) => index + 1).join('\n');

  const followScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(event.target.value);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: readOnly ? 'action.hover' : 'background.paper',
        minHeight,
        height: minHeight,
      }}
    >
      <Box
        component="pre"
        ref={gutter}
        aria-hidden
        sx={{
          m: 0,
          width: GUTTER_WIDTH,
          flex: 'none',
          overflow: 'hidden',
          textAlign: 'right',
          pr: 1,
          py: 1,
          fontFamily: MONO_STACK,
          fontSize: FONT_SIZE,
          lineHeight: LINE_HEIGHT,
          color: 'text.disabled',
          bgcolor: 'action.hover',
          borderRight: 1,
          borderColor: 'divider',
          userSelect: 'none',
        }}
      >
        {numbers}
      </Box>
      <Box
        component="textarea"
        value={value}
        onChange={handleChange}
        onScroll={followScroll}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label={ariaLabel}
        sx={{
          flex: 1,
          minWidth: 0,
          m: 0,
          p: 1,
          border: 0,
          outline: 'none',
          resize: 'none',
          fontFamily: MONO_STACK,
          fontSize: FONT_SIZE,
          lineHeight: LINE_HEIGHT,
          color: theme.palette.text.primary,
          bgcolor: 'transparent',
          whiteSpace: 'pre',
          overflow: 'auto',
        }}
      />
    </Box>
  );
}
