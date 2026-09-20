import { Alert, Card, CardContent, Link, Typography } from '@mui/material';
import type { UploaderLifecycleReading } from '@streaming-infra-manager/common';

function adminLink(base: string, adminId: string): string { return `${base}/#/streams/${encodeURIComponent(adminId)}`; }

export function LifecycleCard({ reading, adminConsoleUrl }: { reading: UploaderLifecycleReading | undefined; adminConsoleUrl: string | null }) {
  if (!reading || reading.state === 'unavailable') return <Alert severity="info">Broadcast status unavailable.</Alert>;
  return <Card><CardContent><Typography variant="h6">Broadcast lifecycle</Typography>{reading.streams.map(stream => <Typography key={`${stream.adminId}/${stream.runNumber}`}>{stream.state === 'waiting' ? 'Waiting for stream to resume' : stream.state === 'closed' ? 'Finishing recording' : stream.state === 'vod' ? 'Completed replay available' : stream.state === 'live' ? 'Live' : 'Preparing broadcast'} · run {stream.runNumber}{adminConsoleUrl ? <><br /><Link href={adminLink(adminConsoleUrl, stream.adminId)} target="_blank" rel="noreferrer">Open stream in admin console</Link></> : <><br />Admin console link is not configured.</>}</Typography>)}</CardContent></Card>;
}
