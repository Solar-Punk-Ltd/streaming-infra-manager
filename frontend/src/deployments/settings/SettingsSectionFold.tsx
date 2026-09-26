import { useId, type ReactNode } from 'react';
import { Box, ButtonBase, Collapse, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { SettingsSection } from './settingsSections';
import { type SectionCounts, sectionSummary } from './settingsText';

/**
 * One section of the sample, folded until it is opened. The heading holds the
 * button rather than the other way round, which is the disclosure pattern a
 * screen reader announces as a heading that expands. The keys of a folded
 * section are not rendered at all, because the whole list is close to a
 * hundred fields.
 */
export function SettingsSectionFold({
  section,
  open,
  counts,
  onToggle,
  children,
}: {
  section: SettingsSection;
  open: boolean;
  counts: SectionCounts;
  onToggle: () => void;
  children: ReactNode;
}) {
  const listId = useId();
  return (
    <Box component="section" sx={{ borderTop: 1, borderColor: 'divider', minWidth: 0 }}>
      <Typography variant="subtitle2" component="h4" sx={{ m: 0 }}>
        <ButtonBase
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', py: 1.25, gap: 1, borderRadius: 1 }}
        >
          <ExpandMoreIcon
            fontSize="small"
            sx={{ flex: 'none', transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }}
          />
          <Stack component="span" sx={{ minWidth: 0 }}>
            <Box component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {section.title}
            </Box>
            <Typography component="span" variant="caption" color="text.secondary">
              {sectionSummary(section.entries.length, counts)}
            </Typography>
          </Stack>
        </ButtonBase>
      </Typography>
      <Collapse in={open} unmountOnExit>
        <Stack component="ul" id={listId} sx={{ m: 0, p: 0, pb: 1, minWidth: 0 }}>
          {children}
        </Stack>
      </Collapse>
    </Box>
  );
}
