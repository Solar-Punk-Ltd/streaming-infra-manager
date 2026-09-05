import {
  Box,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import { STREAM_UPLOADER_SERVICE } from '@streaming-infra-manager/common';

import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { ServiceChip } from '../components/ServiceChip';
import { formatBytes, formatCores, formatSharePercent } from '../format';
import type { ContainerMetrics, MetricsSnapshot, Profile } from '../types';
import { componentUrl, hostFor } from '../urls';
import { isRunning, SERVICE_DESCRIPTIONS } from './shape';

export function ContainersCard({
  profile,
  host,
  snapshot,
  uploaderPending,
}: {
  profile: Profile;
  host: string;
  snapshot: MetricsSnapshot | null;
  /** A running stream whose uploader is still held back for a stamp. */
  uploaderPending: boolean;
}) {
  const containers = profile.containers;

  const metricsFor = (service: string): ContainerMetrics | null =>
    snapshot?.containers.find(
      (c) => c.project === profile.name && c.service === service,
    ) ?? null;

  return (
    <SectionCard
      title="Containers"
      sub={containers.length ? `${containers.length} running` : 'none running'}
      flush
    >
      {containers.length === 0 ? (
        <EmptyState
          title="Start the deployment to see its containers."
          hint="Nothing is running for it right now."
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Service</TableCell>
              <TableCell>What it does</TableCell>
              <TableCell>Ports</TableCell>
              <TableCell>CPU</TableCell>
              <TableCell>Memory</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {containers.map((container) => {
              const metrics = metricsFor(container.service);
              const ports = Object.entries(container.ports);
              return (
                <TableRow key={container.service}>
                  <TableCell>
                    <ServiceChip service={container.service} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {SERVICE_DESCRIPTIONS[container.service] ?? 'part of this stack'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {ports.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        none exposed
                      </Typography>
                    ) : (
                      ports.map(([key, port]) => (
                        <Box key={key} sx={{ fontSize: 12 }}>
                          {key}{' '}
                          <Link
                            href={componentUrl(hostFor(profile, host), port)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {port}
                          </Link>
                        </Box>
                      ))
                    )}
                  </TableCell>
                  <TableCell>
                    {metrics ? (
                      <Typography variant="body2">
                        {formatCores(metrics.cpuPercent)} cores
                      </Typography>
                    ) : (
                      <Dash />
                    )}
                  </TableCell>
                  <TableCell>
                    {metrics && snapshot ? (
                      <>
                        <Typography variant="body2">
                          {formatBytes(metrics.memUsageBytes)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatSharePercent(
                            metrics.memUsageBytes,
                            snapshot.host.memTotalBytes,
                          )}{' '}
                          of the machine
                        </Typography>
                      </>
                    ) : (
                      <Dash />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {uploaderPending && isRunning(profile) && (
              <TableRow>
                <TableCell>
                  <ServiceChip service={STREAM_UPLOADER_SERVICE} />
                </TableCell>
                <TableCell colSpan={4}>
                  <Typography variant="body2" color="text.secondary">
                    not started yet, waiting for a stamp
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function Dash() {
  return (
    <Typography variant="caption" color="text.secondary">
      no sample
    </Typography>
  );
}
