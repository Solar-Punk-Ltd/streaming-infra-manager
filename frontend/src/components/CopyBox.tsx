import { Box, Button, Link } from '@mui/material';

import { MONO_STACK } from '../app/theme';

/**
 * A value the operator has to get out of the screen and into something else: a
 * publish URL, a pool string, an address. Always with its own Copy button, so
 * nothing long ever has to be selected by hand.
 */
export function CopyBox({
  value,
  copyLabel = 'Copy',
  href,
}: {
  value: string;
  copyLabel?: string;
  /** Renders the value as a link as well, for anything that opens in a browser. */
  href?: string;
}) {
  const copy = () => {
    void navigator.clipboard.writeText(value).catch(() => undefined);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        py: 0.875,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'action.hover',
        fontFamily: MONO_STACK,
        fontSize: '0.78125rem',
        wordBreak: 'break-all',
      }}
    >
      {href ? (
        <Link href={href} target="_blank" rel="noopener noreferrer" sx={{ flex: 1 }}>
          {value}
        </Link>
      ) : (
        <Box component="span" sx={{ flex: 1 }}>
          {value}
        </Box>
      )}
      <Button size="small" onClick={copy} sx={{ flex: 'none' }}>
        {copyLabel}
      </Button>
    </Box>
  );
}
