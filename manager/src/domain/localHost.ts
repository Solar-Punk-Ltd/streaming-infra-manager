import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** Mapped to the host gateway in manager/docker-compose.yml, and nowhere else. */
const DOCKER_HOST_NAME = 'host.docker.internal';

/**
 * The host the manager reaches a deployment's published ports on.
 *
 * Inside its own container the manager reaches the host's ports through
 * host.docker.internal, which manager/docker-compose.yml maps to the host
 * gateway. Running natively, in development or the integration suite, that
 * name does not resolve, so the loopback address is used. BEE_LOCAL_HOST
 * overrides both, and keeps its name from when only the Bee API was reached
 * this way.
 */
export const LOCAL_PUBLISHED_HOST =
  process.env.BEE_LOCAL_HOST ??
  (existsSync('/.dockerenv') ? DOCKER_HOST_NAME : '127.0.0.1');

export interface LocalPublisherHostDeps {
  env?: { BEE_LOCAL_HOST?: string | undefined };
  isInContainer?: () => boolean;
  lookupIpv4?: (hostname: string) => Promise<string>;
  warn?: (message: string) => void;
}

/** Answers the address of {@link resolveLocalPublisherHost}, once it is known. */
export type LocalPublisherHostReader = () => Promise<string>;

/**
 * The address a container on this host reaches a node this manager deployed on.
 *
 * This is what an ABR pool string hands an uploader, and the uploader the manager
 * deploys is a container on this same host. T06 binds every local Bee API to the
 * Docker bridge address and to nothing else, so the host's public address answers
 * on those ports from nowhere at all, and the bridge address is the one that
 * works. Inside the api container the bridge is what host.docker.internal
 * resolves to, through the host-gateway mapping in manager/docker-compose.yml.
 *
 * The name itself cannot be handed on. An uploader's compose service carries no
 * extra_hosts, so on Linux that name resolves nowhere inside it, and only a
 * literal address does. Running natively there is no bridge to read, so the name
 * is the answer, which is what Docker Desktop resolves inside a container anyway.
 */
export async function resolveLocalPublisherHost(
  deps: LocalPublisherHostDeps = {},
): Promise<string> {
  return (await readLocalPublisherHost(deps)).host;
}

/**
 * The reader the pool assembly calls, remembering an answer the lookup actually
 * produced. A failed lookup is not an answer: its fallback is the bare name,
 * which the manager's own probe resolves inside its container while an uploader
 * container resolves it nowhere, so caching it would hand out a string that
 * reads as reachable and reaches nothing for the life of the process.
 */
export function localPublisherHostReader(
  deps: LocalPublisherHostDeps = {},
): LocalPublisherHostReader {
  let known: Promise<string> | null = null;
  return async () => {
    if (known) return known;
    const reading = await readLocalPublisherHost(deps);
    if (reading.settled) known = Promise.resolve(reading.host);
    return reading.host;
  };
}

/** The bridge address cannot change while the manager runs, so a settled answer is read once. */
export const localPublisherHost: LocalPublisherHostReader = localPublisherHostReader();

interface LocalPublisherHostReading {
  host: string;
  /** False when the lookup failed and the host is the fallback name. */
  settled: boolean;
}

async function readLocalPublisherHost(
  deps: LocalPublisherHostDeps,
): Promise<LocalPublisherHostReading> {
  const {
    env = process.env,
    isInContainer = () => existsSync('/.dockerenv'),
    lookupIpv4 = async (hostname: string) =>
      (await lookup(hostname, { family: 4 })).address,
    warn = (message: string) => logger.warn(message),
  } = deps;

  const override = env.BEE_LOCAL_HOST?.trim();
  if (override) {
    return override === DOCKER_HOST_NAME
      ? literalAddressOf(override, lookupIpv4, warn)
      : { host: override, settled: true };
  }
  if (!isInContainer()) return { host: DOCKER_HOST_NAME, settled: true };
  return literalAddressOf(DOCKER_HOST_NAME, lookupIpv4, warn);
}

async function literalAddressOf(
  name: string,
  lookupIpv4: (hostname: string) => Promise<string>,
  warn: (message: string) => void,
): Promise<LocalPublisherHostReading> {
  try {
    const address = await lookupIpv4(name);
    if (!isPrivateIpv4(address)) {
      warn(
        `[localHost] ${name} resolved to ${address}, which is not a private address. A docker host gateway is one, ` +
          'so check the host-gateway mapping of the api container before a pool string carries this.',
      );
    }
    return { host: address, settled: true };
  } catch (err) {
    warn(
      `[localHost] ${name} did not resolve (${getErrorMessage(err)}), so a pool string carries the name. ` +
        'An uploader container on Linux resolves it nowhere, and BEE_LOCAL_HOST is the override for that.',
    );
    return { host: name, settled: false };
  }
}

/** RFC 1918, loopback and link-local: every range a docker bridge or a laptop resolver answers with. */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 127 ||
    (first === 169 && second === 254)
  );
}
