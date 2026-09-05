import type { CpuHistoryByContainer } from '../useMetrics';

/**
 * The live extras the container table draws beside a snapshot: CPU history for
 * the sparklines, and disk sizes that are only fetched for the groups the
 * operator actually opens.
 */
export interface LiveMetricsProps {
  history?: CpuHistoryByContainer;
  diskByProject?: Map<string, number | null>;
  onExpandProject?: (project: string) => void;
}
