import { Alert } from '@mui/material';

/**
 * Says the resource numbers next to it have stopped arriving.
 *
 * The cards keep drawing the last sample and the stream keeps its heartbeat, so
 * a manager that has stopped sampling looks like a host where nothing is
 * happening. Only the age of the newest reading separates the two.
 */
export function StaleReadings({ seconds }: { seconds: number }) {
  return (
    <Alert severity="warning">
      Readings are {seconds} seconds old, so these numbers are not live.
    </Alert>
  );
}
