import { useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

/**
 * What to copy: the value, or how to get it for a value the page must not
 * hold until the operator asks for it.
 */
export type Copyable = string | (() => Promise<string | null>);

export function CopyButton({ value, label }: { value: Copyable; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      const text = typeof value === 'string' ? value : await value();
      if (text === null) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable, nothing to report
    }
  };
  return (
    <Tooltip title={copied ? 'Copied' : `Copy ${label}`}>
      <IconButton
        size="small"
        aria-label={`copy ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        <ContentCopyIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}
