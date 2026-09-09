export type VersionRemovalHold = 'changed' | 'references' | 'shipments' | 'executions' | 'marker';

const REASONS: Record<VersionRemovalHold, string> = {
  changed: 'changed while removal was waiting. Reload it before retrying',
  references: 'still has unresolved build references',
  shipments: 'still has a shipment or a retained shipment receipt',
  executions: 'still has an unreleased execution',
  marker: 'has an active or unverifiable removal marker. Finish or resolve the removal before using this version',
};

export class StackVersionRemovalHeldError extends Error {
  constructor(public readonly versionName: string, public readonly reason: VersionRemovalHold) {
    super(`${versionName} ${REASONS[reason]}.`);
    this.name = 'StackVersionRemovalHeldError';
  }
}
