import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { MONO_STACK } from '../app/theme';
import { KeyValueList } from '../components/KeyValueList';
import { ServiceChip } from '../components/ServiceChip';

const SUMMARY =
  'Fixed at creation: type, components, host, name. Remove and recreate to change these.';

/** What an edit cannot touch, folded away until someone wants to check it. */
export function FixedAtCreation({
  type,
  services,
  host,
  name,
}: {
  type: string;
  services: string[];
  host: string;
  name: string;
}) {
  return (
    <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: 'divider' }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />}>
        <Typography variant="caption" color="text.secondary">
          {SUMMARY}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <KeyValueList
          labelWidth={110}
          entries={[
            { key: 'Type', value: type },
            {
              key: 'Components',
              value: (
                <Stack direction="row" spacing={0.5} flexWrap="wrap">
                  {services.map((service) => (
                    <ServiceChip key={service} service={service} />
                  ))}
                </Stack>
              ),
            },
            { key: 'Host', value: <Mono>{host}</Mono> },
            { key: 'Name', value: <Mono>{name}</Mono> },
          ]}
        />
      </AccordionDetails>
    </Accordion>
  );
}

function Mono({ children }: { children: string }) {
  return (
    <Typography component="span" sx={{ fontFamily: MONO_STACK, fontSize: '0.8125rem' }}>
      {children}
    </Typography>
  );
}
