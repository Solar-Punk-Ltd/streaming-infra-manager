import type { StackContract } from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import { parseEnvText } from '../../utils/envUtils.js';
import { beeDataDirsFor } from '../dataDirs.js';
import { omePortsFor, portFor, portTableOf } from '../versions/portTable.js';

/** What a deployment's effective environment is worked out from. */
export interface EffectiveEnvInput {
  profile: Profile;
  contract: StackContract | null | undefined;
  /** The deploy target's alias, which decides whether the data directories are the manager's. */
  target: string;
  /** The deployment's own env file, `.env.<profile>`, as written or as it would be written. */
  rootEnvText: string;
  /** The engine's env file in the same tree, `engines/<engine>/.env`. */
  engineEnvText: string;
}

/**
 * The environment a deployment's containers get, as far as the manager can
 * tell without asking Docker.
 *
 * `deploy.sh` reads the engine's env file beside the deployment's own and lets
 * the root file win. It then has the last word on three kinds of key: it
 * shifts every port of the version's table by the slot, it passes the feed and
 * the stamp as arguments, and on the manager's own host the manager exports
 * the data directories, which beat any line of the file.
 */
export function effectiveEnvOf(input: EffectiveEnvInput): Record<string, string> {
  const { profile, contract, target } = input;
  const env = { ...parseEnvText(input.engineEnvText), ...parseEnvText(input.rootEnvText) };
  Object.assign(env, slottedPortsOf(profile.port_slot, portTableOf(contract), env));
  Object.assign(env, scriptArgumentsOf(profile));
  Object.assign(env, beeDataDirsFor(profile.name, target));
  return env;
}

/**
 * The ports `deploy.sh` settles, shifted by the slot. Slot 0 is no slot, and
 * there a port the files leave unset takes the table's default.
 */
function slottedPortsOf(
  slot: number,
  table: ReturnType<typeof portTableOf>,
  fileEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const ports: Record<string, string> = {};
  for (const port of table) {
    if (slot > 0) ports[port.name] = String(portFor(port, slot));
    else if (!fileEnv[port.name]) ports[port.name] = String(port.defaultPort);
  }
  const apiPort = ports.API_PORT ?? fileEnv.API_PORT;
  if (apiPort) {
    ports.SRS_ADAPTER_PORT = apiPort;
    ports.OME_ADAPTER_PORT = apiPort;
  }
  const ome = omePortsFor(slot, table);
  if (ome.omeSrtPort) ports.OME_SRT_PORT = String(ome.omeSrtPort);
  if (ome.omeHlsPort) ports.OME_HLS_PORT = String(ome.omeHlsPort);
  return ports;
}

/** The keys `deploy.sh` sets from its arguments, as `parameter_overrides_text` in `_lib.sh` maps them. */
function scriptArgumentsOf(profile: Profile): Record<string, string> {
  const args: Record<string, string> = {};
  if (profile.feed_owner) args.VITE_APP_OWNER = profile.feed_owner.replace(/^0x/, '');
  if (profile.feed_topic) {
    args.STREAM_LIST_TOPIC = profile.feed_topic;
    args.VITE_APP_RAW_TOPIC = profile.feed_topic;
  }
  if (profile.stamp_id) args.STAMP = profile.stamp_id.replace(/^0x/, '');
  return args;
}
