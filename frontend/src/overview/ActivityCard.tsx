import { Box, Stack, Typography } from '@mui/material';

import type { ActivityEntry } from '../app/useDeploymentsStore';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { StatusDot } from '../components/StatusDot';

/** What the manager reported since this page was opened, newest first. */
export function ActivityCard({ entries }: { entries: ActivityEntry[] }) {
  return (
    <SectionCard title="Recent activity" flush>
      {entries.length === 0 ? (
        <EmptyState
          title="No changes since this page was opened."
          hint="Starting, stopping or removing a deployment shows up here."
        />
      ) : (
        <Box>
          {entries.map((entry) => (
            <Stack
              key={entry.id}
              direction="row"
              spacing={1.5}
              alignItems="center"
              sx={{
                px: 2.25,
                py: 1.25,
                borderTop: 1,
                borderColor: 'divider',
                '&:first-of-type': { borderTop: 0 },
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ width: 44 }}>
                {entry.time}
              </Typography>
              <StatusDot tone={entry.tone} />
              <Typography variant="body2">{entry.text}</Typography>
            </Stack>
          ))}
        </Box>
      )}
    </SectionCard>
  );
}
