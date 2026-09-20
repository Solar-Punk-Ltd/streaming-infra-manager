import { Alert, Card, CardContent, Link, Typography } from '@mui/material';

import type {
  UploaderLifecycleReading,
  UploaderLifecycleStream,
} from '@streaming-infra-manager/common';

function adminLink(base: string, adminId: string): string {
  return `${base}/#/streams/${encodeURIComponent(adminId)}`;
}

function lifecycleText(stream: UploaderLifecycleStream): string {
  if (stream.state === 'waiting') return 'Waiting for stream to resume';
  if (stream.state === 'closed') {
    if (stream.closeReason === 'empty') return 'Broadcast ended without a recording';
    if (stream.closeReason === 'finalization_failed') return 'Recording finalization failed';
    if (stream.closeReason === 'recovery_required') return 'Recording needs recovery';
    if (stream.closeReason === 'cancelled') return 'Broadcast was cancelled';
    return 'Finishing recording';
  }
  if (stream.state === 'vod') return 'Completed replay available';
  if (stream.state === 'live') return 'Live';
  return 'Preparing broadcast';
}

function reconnectPolicy(stream: UploaderLifecycleStream): string | null {
  if (stream.state !== 'waiting' || stream.deadlineRemainingMs === undefined) return null;
  const seconds = Math.ceil(stream.deadlineRemainingMs / 1000);
  if (seconds === 0) return 'The 60-second reconnect window has ended.';
  return `60-second reconnect policy: ${seconds} ${seconds === 1 ? 'second remains' : 'seconds remain'}.`;
}

export function LifecycleCard({
  reading,
  adminConsoleUrl,
}: {
  reading: UploaderLifecycleReading | undefined;
  adminConsoleUrl: string | null;
}) {
  if (!reading || reading.state === 'unavailable') {
    return <Alert severity="info">Broadcast status unavailable.</Alert>;
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6">Broadcast lifecycle</Typography>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Continue a broadcast in the admin console. Deployment controls only
          start, stop, or restart infrastructure.
        </Typography>
        {reading.streams.map((stream) => (
          <Typography key={`${stream.adminId}/${stream.runNumber}`}>
            {lifecycleText(stream)} · run {stream.runNumber}
            {reconnectPolicy(stream) ? (
              <>
                <br />
                {reconnectPolicy(stream)}
              </>
            ) : null}
            {adminConsoleUrl ? (
              <>
                <br />
                <Link
                  href={adminLink(adminConsoleUrl, stream.adminId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open stream in admin console
                </Link>
              </>
            ) : (
              <>
                <br />
                Admin console link is not configured.
              </>
            )}
          </Typography>
        ))}
      </CardContent>
    </Card>
  );
}
