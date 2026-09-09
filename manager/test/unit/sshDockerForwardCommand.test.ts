import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import { describe, it } from 'node:test';
import { sshDockerForwardCommand } from '../../src/domain/chequebook/sshDockerForwardCommand.js';

const record = () => ({ kind: 'ssh-unix', alias: 'saved-target', host: 'docker.example.invalid', port: 2222, user: 'operator',
  remoteSocketPath: '/run/docker.sock', identityPublicKeyPath: '/synthetic/Selected Key.pub', agentSocketPath: '/synthetic/Agent Socket/agent.sock',
  knownHostsPath: '/synthetic/Known Hosts', hostKeyAlias: 'saved-server-key' });
const options = () => ({ localSocketPath: '/tmp/t09-ssh-synthetic/docker.sock', acquisitionTimeoutMs: 1201 });
const build = (input: unknown = record(), bounds: unknown = options(), alias = 'saved-target') => sshDockerForwardCommand(alias, input, bounds);
const safeError = (error: unknown) => error instanceof Error && error.message ===
  'The private Bee connection could not be acquired. Verify the deployment target before trying again.' && error.cause === undefined;

describe('pure trusted remote Docker forward command', () => {
  it('builds exactly one foreground Unix forward with isolated configuration and selected authentication', () => {
    const command = build();
    assert.equal(command.file, '/usr/bin/ssh');
    assert.deepEqual(command.args, [
      '-F', '/dev/null', '-N', '-T', '-n',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
      '-o', 'SessionType=none', '-o', 'ForkAfterAuthentication=no',
      '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no', '-o', 'CanonicalizeHostname=no',
      '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PubkeyAuthentication=yes',
      '-o', 'IdentitiesOnly=yes', '-i', '/synthetic/Selected Key.pub',
      '-o', 'IdentityAgent="/synthetic/Agent Socket/agent.sock"', '-o', 'PKCS11Provider=none',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'CheckHostIP=no',
      '-o', 'UserKnownHostsFile="/synthetic/Known Hosts"', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlias=saved-server-key',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=no',
      '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=2', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
      '-L', '/tmp/t09-ssh-synthetic/docker.sock:/run/docker.sock', '-p', '2222', '-l', 'operator', '--', 'docker.example.invalid',
    ]);
    assert.deepEqual(command.options, { shell: false, detached: false, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    assert.equal(command.args.filter(value => value === '-L').length, 1);
    assert.equal(command.args.includes('ClearAllForwardings=yes'), false);
  });

  it('never reads path contents, executes SSH or opens a socket while validating and constructing argv', t => {
    const forbidden = () => { throw new Error('External operation forbidden'); };
    for (const name of ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync'] as const) t.mock.method(childProcess, name, forbidden);
    for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'realpathSync'] as const) t.mock.method(fs, name, forbidden);
    for (const name of ['readFile', 'open', 'stat', 'lstat', 'realpath'] as const) t.mock.method(fsPromises, name, forbidden);
    t.mock.method(net, 'connect', forbidden); t.mock.method(net, 'createConnection', forbidden);
    assert.equal(build().file, '/usr/bin/ssh');
    assert.throws(() => build({ ...record(), host: '-ProxyCommand=synthetic' }), safeError);
  });

  it('copies and deeply freezes every retained record, argv and spawn option', () => {
    const input = record(); const bounds = options(); const command = build(input, bounds);
    input.host = 'changed.invalid'; input.agentSocketPath = '/changed'; bounds.localSocketPath = '/changed'; bounds.acquisitionTimeoutMs = 30000;
    assert.equal(command.target.host, 'docker.example.invalid'); assert.equal(command.args.at(-1), 'docker.example.invalid');
    for (const value of [command, command.target, command.args, command.options, command.options.stdio, command.options.env]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => Object.assign(command.target, { alias: 'another' }), TypeError);
    assert.throws(() => Object.assign(command.options.env, { SSH_AUTH_SOCK: '/unselected' }), TypeError);
  });

  for (const host of ['127.0.0.1', '2001:db8::1', '::1', 'node', 'Node.Example.Invalid.']) {
    it(`accepts a separately addressed host ${host} without URL or proxy rewriting`, () => {
      assert.equal(build({ ...record(), host }).args.at(-1), host);
    });
  }
  for (const host of ['', '-host', 'ssh://host', 'user@host', 'host:22', '[::1]', 'fe80::1%en0', '127.1', '2130706433', '999.1.1.1',
    'host name', 'host\nProxyCommand=x', 'host\0x', 'host/path', '$(command)', '%h', '.host', 'host..invalid', '-label.invalid', 'label-.invalid', `${'a'.repeat(64)}.invalid`, 'a'.repeat(254)]) {
    it(`refuses malformed or ambiguous host ${JSON.stringify(host)}`, () => assert.throws(() => build({ ...record(), host }), safeError));
  }
  for (const [field, value] of [
    ['kind', 'unix'], ['alias', 'another'], ['alias', ''], ['user', '-operator'], ['user', 'user@host'], ['user', 'user name'], ['user', 'user\n-oProxyCommand=x'],
    ['hostKeyAlias', '-server'], ['hostKeyAlias', 'key alias'], ['hostKeyAlias', '%h'], ['port', 0], ['port', 65536], ['port', 1.5], ['port', '22'], ['port', NaN],
  ] as const) {
    it(`refuses invalid ${field} ${JSON.stringify(value)}`, () => assert.throws(() => build({ ...record(), [field]: value }), safeError));
  }
  for (const missing of Object.keys(record())) {
    it(`requires explicitly supplied ${missing}`, () => {
      const input: Record<string, unknown> = record(); delete input[missing]; assert.throws(() => build(input), safeError);
    });
  }
  for (const extra of ['sshOptions', 'configFile', 'executable', 'env', 'ProxyCommand', 'ProxyJump', 'LocalCommand', 'RemoteCommand', 'KnownHostsCommand', 'forwards']) {
    it(`refuses unsupported trusted-record field ${extra} rather than incorporating it`, () => {
      assert.throws(() => build({ ...record(), [extra]: 'synthetic-sensitive-command' }), safeError);
    });
  }
  for (const field of ['remoteSocketPath', 'identityPublicKeyPath', 'agentSocketPath', 'knownHostsPath'] as const) {
    for (const path of ['', 'relative/path', '/', '/tmp/../key.pub', '/tmp//key.pub', '/tmp/line\nkey.pub', '/tmp/nul\0key.pub', '/tmp/quote"key.pub',
      "/tmp/quote'key.pub", '/tmp/back\\slash.pub', '/tmp/%h.pub', '/tmp/${HOME}.pub', '/tmp/~key.pub', `/${'x'.repeat(4096)}.pub`]) {
      it(`refuses unsafe ${field} ${JSON.stringify(path).slice(0, 70)}`, () => assert.throws(() => build({ ...record(), [field]: path }), safeError));
    }
  }
  for (const socketPath of ['/tmp/has space.sock', '/tmp/has:colon.sock', `/${'x'.repeat(101)}`, '/tmp/control\t.sock']) {
    it(`refuses ambiguous or oversized forward path ${JSON.stringify(socketPath)}`, () => {
      assert.throws(() => build({ ...record(), remoteSocketPath: socketPath }), safeError);
      assert.throws(() => build(record(), { ...options(), localSocketPath: socketPath }), safeError);
    });
  }
  it('requires the identity route to name a public stub and does not accept a private-key path', () => {
    assert.throws(() => build({ ...record(), identityPublicKeyPath: '/synthetic/id_ed25519' }), safeError);
    assert.throws(() => build({ ...record(), identityPublicKeyPath: '/synthetic/.pub' }), safeError);
  });
  for (const bounds of [null, {}, { ...options(), localSocketPath: undefined }, { ...options(), localSocketPath: 'relative.sock' },
    { ...options(), acquisitionTimeoutMs: 0 }, { ...options(), acquisitionTimeoutMs: 30001 }, { ...options(), acquisitionTimeoutMs: 1.5 },
    { ...options(), acquisitionTimeoutMs: Infinity }, { ...options(), acquisitionTimeoutMs: '30' }, { ...options(), extra: true }]) {
    it(`refuses invalid local bounds ${JSON.stringify(bounds)}`, () => assert.throws(() => build(record(), bounds), safeError));
  }
  for (const ms of [1, 1000, 1001, 30000]) {
    it(`rounds only the native connect timeout for remaining budget ${ms}ms`, () => {
      assert.ok(build(record(), { ...options(), acquisitionTimeoutMs: ms }).args.includes(`ConnectTimeout=${Math.ceil(ms / 1000)}`));
    });
  }
  for (const input of [null, undefined, [], 'synthetic-sensitive', { ...record(), get user() { throw new Error('synthetic-sensitive-getter'); } }]) {
    it('contains malformed input and getter diagnostics behind the fixed acquisition error', () => {
      assert.throws(() => sshDockerForwardCommand('saved-target', input, options()), safeError);
    });
  }
  for (const alias of ['', '-host', 'host with space']) {
    it(`refuses invalid captured alias ${JSON.stringify(alias)}`, () => assert.throws(() => build({ ...record(), alias }, options(), alias), safeError));
  }
});
