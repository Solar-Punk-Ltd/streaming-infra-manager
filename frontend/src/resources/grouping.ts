import type { ContainerMetrics } from '../types';

export interface Group {
  project: string;
  containers: ContainerMetrics[];
  cpuPercent: number;
  memUsageBytes: number;
}

export function groupByProject(containers: ContainerMetrics[]): Group[] {
  const map = new Map<string, ContainerMetrics[]>();
  for (const c of containers) {
    const key = c.project ?? '(unlabeled)';
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([project, list]) => ({
      project,
      containers: list.sort((a, b) =>
        (a.service ?? '').localeCompare(b.service ?? ''),
      ),
      cpuPercent: list.reduce((s, c) => s + c.cpuPercent, 0),
      memUsageBytes: list.reduce((s, c) => s + c.memUsageBytes, 0),
    }))
    // Stable alphabetical order so rows don't jump around as usage changes.
    .sort((a, b) => a.project.localeCompare(b.project));
}
