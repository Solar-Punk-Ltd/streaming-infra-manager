import {
  DEFAULT_MAX_SLOT,
  type StackContract,
  type StackPortVar,
} from '@streaming-infra-manager/common';

/**
 * The port table of the bundled version, `PORT_VARS` in its
 * `deploy/scripts/_lib.sh`, for a deployment whose version has no readable
 * contract. Every added version carries its own table in its contract, read
 * off the checkout when it was built.
 */
export const BUNDLED_PORT_TABLE: readonly StackPortVar[] = [
  'API_PORT',
  'SRS_SRT_PORT',
  'SRS_RTMP_PORT',
  'SRS_HTTP_PORT',
  'CLIENT_PORT',
  'BEE_UPLOADER_API_PORT',
  'BEE_UPLOADER_P2P_PORT',
  'BEE_GATEWAY_API_PORT',
  'BEE_GATEWAY_P2P_PORT',
].map((name, index) => ({
  name,
  defaultPort: 10000 + index,
  slotBase: 10000 + index,
  // The SRT ingest is the one UDP mapping the bundled compose file carries.
  protocol: name === 'SRS_SRT_PORT' ? ('udp' as const) : ('tcp' as const),
}));

/** OvenMediaEngine listens where SRS would, so its ports follow the SRS entries. */
const OME_PORTS_FOLLOW: Record<string, string> = {
  OME_SRT_PORT: 'SRS_SRT_PORT',
  OME_HLS_PORT: 'SRS_HTTP_PORT',
};

export function portTableOf(
  contract: StackContract | null | undefined,
): readonly StackPortVar[] {
  return contract && contract.ports.length > 0
    ? contract.ports
    : BUNDLED_PORT_TABLE;
}

/** The highest port slot the version's deploy script accepts. */
export function maxSlotOf(contract: StackContract | null | undefined): number {
  return contract?.maxSlot ?? DEFAULT_MAX_SLOT;
}

/** What `deploy.sh --portSlot=N` resolves one port variable to. */
export function portFor(port: StackPortVar, portSlot: number): number {
  return portSlot > 0 ? port.slotBase + portSlot * 10 : port.defaultPort;
}

export interface OmePorts {
  omeSrtPort?: number;
  omeHlsPort?: number;
}

/**
 * The OME ports a slot resolves to, from the table the version has, or none
 * for slot 0, where the engine's own env file decides.
 */
export function omePortsFor(
  portSlot: number,
  table: readonly StackPortVar[],
): OmePorts {
  if (portSlot <= 0) return {};
  const byName = new Map(table.map((port) => [port.name, port]));
  const srt = byName.get(OME_PORTS_FOLLOW.OME_SRT_PORT!);
  const hls = byName.get(OME_PORTS_FOLLOW.OME_HLS_PORT!);
  return {
    ...(srt ? { omeSrtPort: portFor(srt, portSlot) } : {}),
    ...(hls ? { omeHlsPort: portFor(hls, portSlot) } : {}),
  };
}
