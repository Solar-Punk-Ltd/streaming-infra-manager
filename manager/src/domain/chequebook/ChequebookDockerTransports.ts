import { posix } from 'node:path';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { isLocalTarget, targetAlias } from '../ports/DeployTargets.js';
import type { LocalDockerLocator } from './acquireLocalDockerBeeStream.js';
import { createBeeBridgeQualifier, PRODUCTION_BEE_BRIDGE_QUALIFICATIONS, type BeeBridgeQualificationRecord, type QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';
import { DEFAULT_REMOTE_DOCKER_SOCKET, sshDockerForwardCommand, type SshDockerLocator } from './sshDockerForwardCommand.js';

export interface SelectedChequebookTransport {
  readonly locator: Readonly<LocalDockerLocator | SshDockerLocator>;
  readonly qualify: QualifiedBeeBridgeExecution;
}

/** The socket the manager's own Docker client uses when DOCKER_HOST says nothing. */
export const DEFAULT_LOCAL_DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * The local socket the manager's own Docker client connects to, read from
 * DOCKER_HOST the way that client reads it, or null when DOCKER_HOST reaches
 * Docker some other way, which a transfer cannot own as a socket.
 */
export function localDockerSocketPath(dockerHost: string | undefined): string | null {
  if (!dockerHost) return DEFAULT_LOCAL_DOCKER_SOCKET;
  if (!dockerHost.startsWith('unix://')) return null;
  const path = dockerHost.slice('unix://'.length);
  if (!path) return DEFAULT_LOCAL_DOCKER_SOCKET;
  return posix.isAbsolute(path) ? path : null;
}

/** Where a transfer reaches Docker for a host that CHEQUEBOOK_DOCKER_TRANSPORTS does not name. */
export interface DefaultDockerRoutes {
  readonly localSocketPath: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChequebookConfigurationError();
  return value as Record<string, unknown>;
}

function locator(alias: string, input: unknown): SelectedChequebookTransport['locator'] {
  const value = object(input);
  if (value.kind === 'ssh-unix' || value.kind === 'ssh-config') {
    return sshDockerForwardCommand(alias, value, { localSocketPath: '/pending/docker.sock', acquisitionTimeoutMs: 1 }).target;
  }
  if (Object.keys(value).sort().join(',') !== 'alias,kind,socketPath' || value.kind !== 'unix' || value.alias !== alias ||
      typeof value.socketPath !== 'string' || value.socketPath === '/' || value.socketPath.endsWith('/') ||
      !posix.isAbsolute(value.socketPath) || posix.normalize(value.socketPath) !== value.socketPath ||
      /[\u0000-\u001f\u007f]/.test(value.socketPath) || Buffer.byteLength(value.socketPath) > 100) throw new ChequebookConfigurationError();
  return Object.freeze({ kind: 'unix', alias, socketPath: value.socketPath });
}

/**
 * Which Docker connection a transfer reaches a host's Bee node through. An
 * entry in CHEQUEBOOK_DOCKER_TRANSPORTS wins for the alias it names. Any other
 * host gets the connection the manager already uses for it: its own local
 * socket for localhost, and for a remote alias a forward of the remote socket
 * through the manager's ssh configuration for that alias. Selection is lazy, so
 * journal history and exact replay never depend on this configuration.
 */
export class ChequebookDockerTransports {
  readonly #catalog: readonly BeeBridgeQualificationRecord[];

  constructor(private readonly configuration: string | undefined, catalog: readonly BeeBridgeQualificationRecord[] = PRODUCTION_BEE_BRIDGE_QUALIFICATIONS,
    private readonly defaults: DefaultDockerRoutes = { localSocketPath: DEFAULT_LOCAL_DOCKER_SOCKET }) {
    try { this.#catalog = structuredClone(catalog); }
    catch { throw new ChequebookConfigurationError(); }
  }

  select(alias: string): SelectedChequebookTransport {
    if (!alias || targetAlias(alias) !== alias) throw new ChequebookConfigurationError('target_changed');
    const entries = this.configuration ? this.entries(this.configuration) : {};
    return Object.hasOwn(entries, alias) ? this.configured(alias, entries[alias]) : this.defaultRoute(alias);
  }

  private configured(alias: string, input: unknown): SelectedChequebookTransport {
    try {
      const entry = object(input);
      const fields = Object.keys(entry).sort().join(',');
      if (fields !== 'locator' && fields !== 'locator,qualificationIds') throw new ChequebookConfigurationError();
      const ids = Object.hasOwn(entry, 'qualificationIds') ? entry.qualificationIds : this.#catalog.map(record => record.id);
      if (!Array.isArray(ids) || !ids.length || ids.length > 256 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !this.#catalog.some(record => record.id === id))) throw new ChequebookConfigurationError();
      const qualify = createBeeBridgeQualifier(this.#catalog, ids);
      return Object.freeze({ locator: locator(alias, entry.locator), qualify });
    } catch { throw new ChequebookConfigurationError('docker_setting_invalid'); }
  }

  private defaultRoute(alias: string): SelectedChequebookTransport {
    try {
      const qualify = createBeeBridgeQualifier(this.#catalog, this.#catalog.map(record => record.id));
      if (isLocalTarget(alias)) {
        if (!this.defaults.localSocketPath) throw new ChequebookConfigurationError();
        return Object.freeze({ locator: locator(alias, { kind: 'unix', alias, socketPath: this.defaults.localSocketPath }), qualify });
      }
      return Object.freeze({ locator: locator(alias, { kind: 'ssh-config', alias, remoteSocketPath: DEFAULT_REMOTE_DOCKER_SOCKET }), qualify });
    } catch { throw new ChequebookConfigurationError('docker_route_missing'); }
  }

  private entries(configuration: string): Record<string, unknown> {
    try {
      if (Buffer.byteLength(configuration) > 65536) throw new ChequebookConfigurationError();
      const entries = object(JSON.parse(configuration));
      if (Object.keys(entries).length > 256) throw new ChequebookConfigurationError();
      return entries;
    } catch { throw new ChequebookConfigurationError('docker_setting_invalid'); }
  }
}
