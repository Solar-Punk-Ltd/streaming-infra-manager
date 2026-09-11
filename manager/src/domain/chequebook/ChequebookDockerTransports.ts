import { posix } from 'node:path';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { targetAlias } from '../ports/DeployTargets.js';
import type { LocalDockerLocator } from './acquireLocalDockerBeeStream.js';
import { createBeeBridgeQualifier, PRODUCTION_BEE_BRIDGE_QUALIFICATIONS, type BeeBridgeQualificationRecord, type QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';
import { sshDockerForwardCommand, type TrustedSshDockerLocator } from './sshDockerForwardCommand.js';

export interface SelectedChequebookTransport {
  readonly locator: Readonly<LocalDockerLocator | TrustedSshDockerLocator>;
  readonly qualify: QualifiedBeeBridgeExecution;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChequebookConfigurationError();
  return value as Record<string, unknown>;
}

function locator(alias: string, input: unknown): SelectedChequebookTransport['locator'] {
  const value = object(input);
  if (value.kind === 'ssh-unix') return sshDockerForwardCommand(alias, value, { localSocketPath: '/pending/docker.sock', acquisitionTimeoutMs: 1 }).target;
  if (Object.keys(value).sort().join(',') !== 'alias,kind,socketPath' || value.kind !== 'unix' || value.alias !== alias ||
      typeof value.socketPath !== 'string' || value.socketPath === '/' || value.socketPath.endsWith('/') ||
      !posix.isAbsolute(value.socketPath) || posix.normalize(value.socketPath) !== value.socketPath ||
      /[\u0000-\u001f\u007f]/.test(value.socketPath) || Buffer.byteLength(value.socketPath) > 100) throw new ChequebookConfigurationError();
  return Object.freeze({ kind: 'unix', alias, socketPath: value.socketPath });
}

/** Lazy selection keeps journal history and exact replay independent of current transport configuration. */
export class ChequebookDockerTransports {
  readonly #catalog: readonly BeeBridgeQualificationRecord[];

  constructor(private readonly configuration: string | undefined, catalog: readonly BeeBridgeQualificationRecord[] = PRODUCTION_BEE_BRIDGE_QUALIFICATIONS) {
    try { this.#catalog = structuredClone(catalog); }
    catch { throw new ChequebookConfigurationError(); }
  }

  select(alias: string): SelectedChequebookTransport {
    try {
      if (!alias || targetAlias(alias) !== alias || !this.configuration || Buffer.byteLength(this.configuration) > 65536) throw new ChequebookConfigurationError();
      const entries = object(JSON.parse(this.configuration));
      if (Object.keys(entries).length > 256 || !Object.hasOwn(entries, alias)) throw new ChequebookConfigurationError();
      const entry = object(entries[alias]);
      if (Object.keys(entry).sort().join(',') !== 'locator,qualificationIds') throw new ChequebookConfigurationError();
      const ids = entry.qualificationIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 256 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !this.#catalog.some(record => record.id === id))) throw new ChequebookConfigurationError();
      const qualify = createBeeBridgeQualifier(this.#catalog, ids);
      return Object.freeze({ locator: locator(alias, entry.locator), qualify });
    } catch { throw new ChequebookConfigurationError(); }
  }
}
