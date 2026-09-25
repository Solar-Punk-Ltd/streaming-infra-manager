import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';

import { useEditors } from '../app/EditorsContext';
import { MONO_STACK } from '../app/theme';
import { KeyValueList, type KeyValueEntry } from '../components/KeyValueList';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import {
  RAISE_LATENCY_ACTION,
  type SrtIngestLoad,
  type SrtIngestRow,
  srtIngestView,
} from './srtIngestText';

/**
 * How the SRT link from the broadcaster into SRS held up over the last minute,
 * from the statistics SRS prints into its own log, and what to change when it
 * is dropping packets.
 *
 * Nothing on the broadcaster's side, the manager or the uploader shows packet
 * loss on the way in, and a stream that is breaking up for that reason looks
 * healthy everywhere else on this page. The card only reports: it changes no
 * setting and gates nothing.
 */
export function SrtIngestCard({
  profile,
  load,
  latencySettingOffered,
}: {
  profile: Profile;
  load: SrtIngestLoad;
  latencySettingOffered: boolean;
}) {
  const { openEngineSettings } = useEditors();
  const view = srtIngestView(load, { latencySettingOffered });

  return (
    <SectionCard
      title="SRT ingest"
      sub="the link from the broadcaster into SRS"
      actions={<ReadinessPill label={view.pill.label} tone={view.pill.tone} />}
    >
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          {view.summary}
        </Typography>

        {view.rows.length > 0 && (
          <KeyValueList entries={view.rows.map(countEntry)} labelWidth={150} />
        )}

        {view.verdict && <Typography variant="body2">{view.verdict}</Typography>}

        {view.remedy && (
          <Alert severity={view.remedy.severity}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {view.remedy.title}
            </Typography>
            <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
              {view.remedy.steps.map((step) => (
                <Box component="li" key={step.text} sx={{ mt: 0.5 }}>
                  <Typography variant="body2">{step.text}</Typography>
                  {step.action === RAISE_LATENCY_ACTION && (
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<TuneIcon />}
                      onClick={() => openEngineSettings(profile.name)}
                      sx={{ mt: 0.5 }}
                    >
                      Engine settings
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}

function countEntry(row: SrtIngestRow): KeyValueEntry {
  return {
    key: row.label,
    value: (
      <Stack spacing={0.5}>
        <Box component="span" sx={{ fontFamily: MONO_STACK }}>
          {row.value}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {row.detail}
        </Typography>
      </Stack>
    ),
  };
}
