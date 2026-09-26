import {
  effectiveEngineDefaults,
  type EngineDefaults,
  type EngineName,
  type StackContract,
} from '@streaming-infra-manager/common';

import { parseBaseEnv } from '../../utils/envUtils.js';
import { Logger } from '../Logger.js';

const logger = Logger.getInstance();

/**
 * What an unset engine setting falls back to on the host whose checkout is at
 * `root`, and where each value came from.
 *
 * `.env.<profile>` is a fresh copy of the host's base `.env` on every deploy
 * and an unset key is left out of it, so a key set on the box by hand is what
 * the container starts with. Naming the stack's own value instead would
 * describe a deployment nobody is running. The Engine card, the engine
 * settings route and a deployment's settings list all name their defaults
 * from here, so the three cannot disagree about one host.
 */
export function engineDefaultsAt(
  root: string,
  engine: EngineName,
  contract: StackContract | null | undefined,
): EngineDefaults {
  const defaults = effectiveEngineDefaults(engine, parseBaseEnv(root), contract?.engineDefaults ?? {});
  if (defaults.rejected.length > 0) {
    logger.warn(
      `[EngineDefaults] The base .env sets ${defaults.rejected.join(', ')} to a value ${engine} would refuse. ` +
        'The stack default stands for those.',
    );
  }
  return defaults;
}
