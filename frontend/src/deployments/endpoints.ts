/** How an endpoint is reached, which decides what the port cell offers. */
export type EndpointProtocol = 'http' | 'srt' | 'rtmp' | 'swarm-p2p' | 'tcp';

/** Who an endpoint is for: anyone, the operator's tools, or the stack's own containers. */
export type EndpointAudience = 'public' | 'administrative' | 'internal';

export interface EndpointKind {
  protocol: EndpointProtocol;
  audience: EndpointAudience;
  /** For the port cell: what it is, how it is reached, who it is for. */
  label: string;
  /**
   * Only a page meant for a browser gets a link. An API kept behind the
   * firewall speaks HTTP too, but a link to it says it should open from here,
   * which it should not.
   */
  opensInBrowser: boolean;
}

/**
 * What a port is, read off its key in the deployment's port table.
 *
 * The keys come from the stack's port table (`API_PORT`, `SRS_SRT_PORT`,
 * `BEE_UPLOADER_P2P_PORT` and so on) and the word in the key says the
 * protocol. A key this does not know is shown as a plain TCP port with no
 * link, which claims nothing. A version's port contract can name the protocol
 * outright once it carries one.
 */
export function endpointKindOf(portKey: string): EndpointKind {
  const key = portKey.toUpperCase();
  if (key.includes('SRT')) {
    return {
      protocol: 'srt',
      audience: 'public',
      label: 'SRT ingest, UDP, public',
      opensInBrowser: false,
    };
  }
  if (key.includes('RTMP')) {
    return {
      protocol: 'rtmp',
      audience: 'public',
      label: 'RTMP ingest, TCP, public',
      opensInBrowser: false,
    };
  }
  if (key.includes('P2P')) {
    return {
      protocol: 'swarm-p2p',
      audience: 'public',
      label: 'Swarm peers, TCP and UDP, public',
      opensInBrowser: false,
    };
  }
  if (key.includes('API')) {
    return {
      protocol: 'http',
      audience: 'administrative',
      label: 'API, HTTP, administrative',
      opensInBrowser: false,
    };
  }
  if (key === 'CLIENT_PORT') {
    return {
      protocol: 'http',
      audience: 'public',
      label: 'viewer page, HTTP, public',
      opensInBrowser: true,
    };
  }
  if (key.includes('HTTP') || key.includes('HLS')) {
    return {
      protocol: 'http',
      audience: 'internal',
      label: 'HLS, HTTP, internal',
      opensInBrowser: false,
    };
  }
  return { protocol: 'tcp', audience: 'internal', label: 'TCP', opensInBrowser: false };
}

/** The address to hand to a tool, in the form that tool takes. */
export function endpointAddress(kind: EndpointKind, host: string, port: number): string {
  switch (kind.protocol) {
    case 'http':
      return `http://${host}:${port}`;
    case 'srt':
      return `srt://${host}:${port}`;
    case 'rtmp':
      return `rtmp://${host}:${port}`;
    default:
      return `${host}:${port}`;
  }
}
