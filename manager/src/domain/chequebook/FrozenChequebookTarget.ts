import { isDeepStrictEqual } from 'node:util';
import { ChequebookTargetChangedError } from '../errors/ChequebookTargetChangedError.js';

/** SQL ownership only. Docker identity and the private Bee connection must be acquired separately. */
export interface FrozenChequebookTarget {
  readonly version: 1;
  readonly profile: {
    readonly name: string;
    readonly instanceId: string;
    readonly intentRevision: number;
    readonly engineConfigRevision: number;
    readonly kind: string;
    readonly components: readonly string[] | null;
    readonly host: string | null;
    readonly portSlot: number;
    readonly stackVersionId: number;
    readonly status: string;
  };
  readonly alias: string;
  readonly daemonId: string;
  /** PostgreSQL microseconds are retained so two verification writes cannot collapse to one epoch. */
  readonly verifiedAt: string;
  readonly reservation: {
    readonly id: number;
    readonly protocol: 'tcp';
    readonly port: number;
    readonly service: 'bee-uploader';
    readonly portVar: 'BEE_UPLOADER_API_PORT';
  };
}

export function sameFrozenTarget(input: unknown, current: FrozenChequebookTarget): input is FrozenChequebookTarget {
  return isDeepStrictEqual(input, current);
}

/** Only enough shape is read to acquire locks. Full equality with the database is checked under them. */
export function targetLockIdentity(input: unknown): Pick<FrozenChequebookTarget, 'alias' | 'daemonId'> {
  if (!input || typeof input !== 'object') throw new ChequebookTargetChangedError();
  const { alias, daemonId } = input as Record<string, unknown>;
  if (typeof alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/.test(alias) ||
      typeof daemonId !== 'string' || !daemonId.trim() || daemonId.length > 200) throw new ChequebookTargetChangedError();
  return { alias, daemonId };
}
