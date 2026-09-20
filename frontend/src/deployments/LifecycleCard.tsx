import { Alert, Card, CardContent, Link, Typography } from '@mui/material';

import type { UploaderLifecycleReading } from '@streaming-infra-manager/common';

function adminLink(base: string, adminId: string): string {
  return `${base}/#/streams/${encodeURIComponent(adminId)}`;
}

function lifecycleText(state: string): string {
  if (state === 'waiting') return 'Waiting for stream to resume';
  if (state === 'closed') return 'Finishing recording';
  if (state === 'vod') return 'Completed replay available';
  if (state === 'live') return 'Live';
  return 'Preparing broadcast';
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
            {lifecycleText(stream.state)} · run {stream.runNumber}
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
