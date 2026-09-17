import { configuredBeeRpcEndpoint } from './rpcEndpointSource.js';

/** What is left of an address the manager will not pass on whole. */
function maskFor(address: string): string {
  const { host } = configuredBeeRpcEndpoint(address);
  return host ? `<${host}>` : '<redacted>';
}

// The characters a regular expression would read as syntax. The address becomes
// a pattern below, and a URL carries several of them.
const REGEXP_SYNTAX_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Every occurrence of a known endpoint in text the manager did not write,
 * replaced by its host in angle brackets.
 *
 * Bee prints the value of `--blockchain-rpc-endpoint` into its own log on every
 * start, and prints it again when it cannot reach the chain. The manager serves
 * that container log to a page and keeps a failed start's last lines as the
 * deployment's error, so an endpoint carrying a key in its path reaches a
 * screen, the events stream and the database unless it is taken out here.
 *
 * The host is kept because an operator has to be able to tell which endpoint a
 * line is about, and it is the part that carries no key. The angle brackets are
 * there so that what is left reads as a redaction rather than as an address: a
 * bare host substituted into a log line would say the node was started with
 * that address, which is a different and false statement, and somebody would
 * eventually copy it back into a config.
 *
 * This cannot reach the node's own container log on the host, which `docker
 * logs` shows to anyone with docker access there. The answer to that one is to
 * use an endpoint that carries no key, and the manager's env sample says so.
 */
export function redactEndpoints(
  text: string,
  endpoints: readonly (string | null | undefined)[],
): string {
  const addresses = [
    ...new Set(
      endpoints
        .map((endpoint) => endpoint?.trim())
        .filter((endpoint): endpoint is string => Boolean(endpoint)),
    ),
  ]
    // Longest first: where one endpoint is the beginning of another, replacing
    // the shorter one first leaves the rest of the longer one standing, and the
    // rest is the part carrying the key.
    .sort((left, right) => right.length - left.length);

  let out = text;
  for (const address of addresses) {
    const pattern = new RegExp(
      `${address.replace(REGEXP_SYNTAX_RE, '\\$&')}/?`,
      'g',
    );
    // A replacer function rather than the mask itself, because as a replacement
    // string `$&` and its siblings are substitution patterns. The mask is built
    // from a host and carries none today, and this is what keeps that from
    // mattering.
    out = out.replace(pattern, () => maskFor(address));
  }
  return out;
}
