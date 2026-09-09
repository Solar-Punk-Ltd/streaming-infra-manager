import { isIP } from 'node:net';
import { posix } from 'node:path';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { targetAlias } from '../ports/DeployTargets.js';

/** Operator-owned routing only. No field comes from a profile or money request. */
export interface TrustedSshDockerLocator {
  readonly kind: 'ssh-unix';
  readonly alias: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly remoteSocketPath: string;
  readonly identityPublicKeyPath: string;
  readonly agentSocketPath: string;
  readonly knownHostsPath: string;
  readonly hostKeyAlias: string;
}

export interface SshDockerForwardCommand {
  readonly target: Readonly<TrustedSshDockerLocator>;
  readonly file: '/usr/bin/ssh';
  readonly args: readonly string[];
  readonly options: {
    readonly shell: false;
    readonly detached: false;
    readonly stdio: readonly ['ignore', 'ignore', 'pipe'];
    readonly env: Readonly<{ PATH: string; LANG: string; LC_ALL: string }>;
  };
}

const LOCATOR_FIELDS = ['kind', 'alias', 'host', 'port', 'user', 'remoteSocketPath', 'identityPublicKeyPath', 'agentSocketPath', 'knownHostsPath', 'hostKeyAlias'];
const FORWARD_FIELDS = ['localSocketPath', 'acquisitionTimeoutMs'];

function exactFields(input: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DockerBeeAcquisitionError();
  const fields = Object.keys(input);
  if (fields.length !== expected.length || fields.some(field => !expected.includes(field))) throw new DockerBeeAcquisitionError();
  return input as Record<string, unknown>;
}

function identifier(value: unknown, expression: RegExp): string {
  if (typeof value !== 'string' || !expression.test(value)) throw new DockerBeeAcquisitionError();
  return value;
}

function destinationHost(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 253 || /[^a-zA-Z0-9.:-]/.test(input)) throw new DockerBeeAcquisitionError();
  if (isIP(input)) return input;
  if (input.includes(':') || /^[0-9.]+$/.test(input)) throw new DockerBeeAcquisitionError();
  const labels = (input.endsWith('.') ? input.slice(0, -1) : input).split('.');
  if (labels.some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) throw new DockerBeeAcquisitionError();
  return input;
}

function literalPath(input: unknown, socket = false): string {
  if (typeof input !== 'string' || input === '/' || input.endsWith('/') || !posix.isAbsolute(input) || posix.normalize(input) !== input ||
      /[\u0000-\u001f\u007f"'\\%$~]|[^\S ]/.test(input) || Buffer.byteLength(input) > (socket ? 100 : 4095) ||
      (socket && /[\s:]/.test(input))) throw new DockerBeeAcquisitionError();
  return input;
}

function integer(input: unknown, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum) throw new DockerBeeAcquisitionError();
  return input;
}

/**
 * Pure argv construction, no path-content reads or process creation. Do not log the returned routing paths.
 * The caller must own the local socket directory and enforce the original monotonic acquisition deadline.
 */
export function sshDockerForwardCommand(expectedAlias: string, input: unknown, options: unknown): SshDockerForwardCommand {
  try {
    const captured = exactFields(structuredClone(input), LOCATOR_FIELDS);
    const limits = exactFields(structuredClone(options), FORWARD_FIELDS);
    if (typeof expectedAlias !== 'string' || !expectedAlias || targetAlias(expectedAlias) !== captured.alias || captured.kind !== 'ssh-unix') throw new DockerBeeAcquisitionError();
    const target: Readonly<TrustedSshDockerLocator> = Object.freeze({ kind: 'ssh-unix', alias: expectedAlias,
      host: destinationHost(captured.host), port: integer(captured.port, 65535),
      user: identifier(captured.user, /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/),
      hostKeyAlias: identifier(captured.hostKeyAlias, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
      remoteSocketPath: literalPath(captured.remoteSocketPath, true), identityPublicKeyPath: literalPath(captured.identityPublicKeyPath),
      agentSocketPath: literalPath(captured.agentSocketPath), knownHostsPath: literalPath(captured.knownHostsPath),
    });
    if (!target.identityPublicKeyPath.endsWith('.pub') || posix.basename(target.identityPublicKeyPath).length <= 4) throw new DockerBeeAcquisitionError();
    const localSocketPath = literalPath(limits.localSocketPath, true);
    const timeoutSeconds = Math.ceil(integer(limits.acquisitionTimeoutMs, 30_000) / 1000);
    // -o uses OpenSSH's option parser. Quotes preserve ordinary spaces after literal-path validation excludes expansion and quoting syntax.
    const args = Object.freeze([
      '-F', '/dev/null', '-N', '-T', '-n',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
      '-o', 'SessionType=none', '-o', 'ForkAfterAuthentication=no',
      '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no', '-o', 'CanonicalizeHostname=no',
      '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PubkeyAuthentication=yes',
      '-o', 'IdentitiesOnly=yes', '-i', target.identityPublicKeyPath,
      '-o', `IdentityAgent="${target.agentSocketPath}"`, '-o', 'PKCS11Provider=none',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'CheckHostIP=no',
      '-o', `UserKnownHostsFile="${target.knownHostsPath}"`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlias=${target.hostKeyAlias}`,
      '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=no',
      '-o', 'ConnectionAttempts=1', '-o', `ConnectTimeout=${timeoutSeconds}`, '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
      '-L', `${localSocketPath}:${target.remoteSocketPath}`, '-p', String(target.port), '-l', target.user, '--', target.host,
    ]);
    return Object.freeze({ target, file: '/usr/bin/ssh', args, options: Object.freeze({ shell: false, detached: false,
      stdio: Object.freeze(['ignore', 'ignore', 'pipe'] as const), env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }) }) });
  } catch { throw new DockerBeeAcquisitionError(); }
}
