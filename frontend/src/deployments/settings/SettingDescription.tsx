import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';

import { descriptionPreview } from './settingsText';

/**
 * What the version's sample says about a key. Some explain a key for a page,
 * so a long one opens on its first lines with the rest a click away.
 */
export function SettingDescription({ settingKey, description }: { settingKey: string; description: string }) {
  const [expanded, setExpanded] = useState(false);
  if (description === '') return null;
  const preview = descriptionPreview(description);
  return (
    <Box sx={{ mb: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
        {expanded || !preview.cut ? description : preview.text}
      </Typography>
      {preview.cut && (
        <Button
          size="small"
          sx={{ px: 0, minWidth: 0 }}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Less' : 'More'} about ${settingKey}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Less' : 'More'}
        </Button>
      )}
    </Box>
  );
}
