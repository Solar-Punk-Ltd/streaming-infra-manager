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
      : override;
  }
  if (!isInContainer()) return DOCKER_HOST_NAME;
  return literalAddressOf(DOCKER_HOST_NAME, lookupIpv4, warn);
}

async function literalAddressOf(
  name: string,
  lookupIpv4: (hostname: string) => Promise<string>,
  warn: (message: string) => void,
): Promise<string> {
  try {
    return await lookupIpv4(name);
  } catch (err) {
    warn(
      `[localHost] ${name} did not resolve (${getErrorMessage(err)}), so a pool string carries the name. ` +
        'An uploader container on Linux resolves it nowhere, and BEE_LOCAL_HOST is the override for that.',
    );
    return name;
  }
}

let resolution: Promise<string> | null = null;

/** The bridge address cannot change while the manager runs, so it is read once. */
export const localPublisherHost: LocalPublisherHostReader = () =>
  (resolution ??= resolveLocalPublisherHost());
