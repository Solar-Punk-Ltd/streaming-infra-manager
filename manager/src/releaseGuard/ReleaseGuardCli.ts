import { fileURLToPath } from 'node:url';

import { FixedReleaseAdapter, type FixedAdapterArguments } from './FixedReleaseAdapter.js';
import { installReleaseGuard, ReleaseGuardStore } from './ReleaseGuardStore.js';
import { submitPendingReceipt, validateReleaseReceiptDestination } from './ReleaseReceiptSubmitter.js';
import { digestReleaseCandidate, runReleaseTransition } from './ReleaseTransition.js';
import type { ReleaseRole, ReleaseSlot } from './ReleaseGuardTypes.js';

const TOKEN_ENV = 'RELEASE_GUARD_ADMIN_TOKEN';
const ADMIN_URL_ENV = 'RELEASE_GUARD_ADMIN_URL';
const ROLES = new Set<ReleaseRole>(['manager', 'admin', 'uploader', 'viewer']);
const UPLOADER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Installed wrapper entry point. It exposes fixed roles and never an arbitrary command. */
export async function runReleaseGuardCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const [command, ...rest] = argv;
  if (command === 'digest') {
    const flags = parseFlags(rest, new Set(['candidate-root']));
    return digestReleaseCandidate(required(flags, 'candidate-root'));
  }
  if (command === 'install') {
    const flags = parseFlags(rest, new Set(['state-root']));
    await installReleaseGuard(required(flags, 'state-root'));
    return 'release guard installed';
  }
  if (command === 'status') {
    const flags = parseFlags(rest, new Set(['state-root']));
    return new ReleaseGuardStore(required(flags, 'state-root')).releaseMode();
  }
  if (command === 'retry') {
    const flags = parseFlags(rest, new Set(['state-root', 'role', 'slot-id', 'admin-url']));
    const slot = releaseSlot(required(flags, 'role'), flags.get('slot-id'));
    const destination = receiptDestination(flags, env);
    await submitPendingReceipt({
      store: new ReleaseGuardStore(required(flags, 'state-root')),
      slot,
      ...destination,
    });
    return 'release receipt acknowledged';
  }
  if (!command || !ROLES.has(command as ReleaseRole)) throw new Error('release guard command is invalid');
  const role = command as ReleaseRole;
  const allowed = new Set([
    'state-root',
    'candidate-root',
    'work-root',
    'admin-url',
    'slot-id',
    'profile',
    'port-slot',
    'target',
    'services',
  ]);
  const flags = parseFlags(rest, allowed);
  const slot = releaseSlot(role, flags.get('slot-id'));
  const adapterArgs = adapterArguments(role, flags);
  const destination = receiptDestination(flags, env);
  const store = new ReleaseGuardStore(required(flags, 'state-root'));
  await runReleaseTransition({
    store,
    candidateRoot: required(flags, 'candidate-root'),
    slot,
    adapter: new FixedReleaseAdapter(
      role,
      required(flags, 'work-root'),
      adapterArgs,
    ),
  });
  await submitPendingReceipt({
    store,
    slot,
    ...destination,
  });
  return `${role} release verified and acknowledged`;
}

function releaseSlot(roleValue: string, id: string | undefined): ReleaseSlot {
  if (!ROLES.has(roleValue as ReleaseRole)) throw new Error('release role is invalid');
  const role = roleValue as ReleaseRole;
  if (role === 'uploader') {
    if (!id) throw new Error('uploader release requires --slot-id');
    if (!UPLOADER_ID.test(id)) throw new Error('uploader slot id is invalid');
    return { role, id };
  }
  if (id !== undefined && id !== 'default') throw new Error(`${role} slot id must be default`);
  return { role, id: 'default' };
}

function adapterArguments(role: ReleaseRole, flags: Map<string, string>): FixedAdapterArguments {
  const names = ['profile', 'port-slot', 'target', 'services'];
  if (role !== 'uploader') {
    if (names.some((name) => flags.has(name))) throw new Error(`${role} release does not accept deployment arguments`);
    return {};
  }
  const portSlotText = required(flags, 'port-slot');
  if (!/^\d+$/.test(portSlotText)) throw new Error('uploader port slot is invalid');
  const portSlot = Number(portSlotText);
  if (!Number.isSafeInteger(portSlot) || portSlot < 1 || portSlot > 99) throw new Error('uploader port slot is invalid');
  const services = required(flags, 'services').split(',');
  if (services.some((service) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(service)) || new Set(services).size !== services.length) {
    throw new Error('uploader services are invalid');
  }
  const profile = required(flags, 'profile');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw new Error('uploader profile is invalid');
  const target = required(flags, 'target');
  if (target !== 'local') throw new Error('installed uploader adapter target must be local');
  return { profile, portSlot, target, services };
}

function parseFlags(argv: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('release guard arguments must be --name value pairs');
    }
    const key = name.slice(2);
    if (!allowed.has(key)) throw new Error(`release guard argument --${key} is not supported`);
    if (flags.has(key)) throw new Error(`release guard argument --${key} is duplicated`);
    flags.set(key, value);
  }
  return flags;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`release guard requires --${name}`);
  return value;
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`release guard requires ${name} in its process environment`);
  return value;
}

function receiptDestination(flags: Map<string, string>, env: NodeJS.ProcessEnv): { adminUrl: string; token: string } {
  const adminUrl = flags.get('admin-url') ?? requiredEnvironment(env, ADMIN_URL_ENV);
  const token = requiredEnvironment(env, TOKEN_ENV);
  validateReleaseReceiptDestination(adminUrl, token);
  return { adminUrl, token };
}

async function main(): Promise<void> {
  try {
    const result = await runReleaseGuardCli(process.argv.slice(2));
    process.stdout.write(`${result}\n`);
  } catch (error) {
    process.stderr.write(`REFUSED: ${error instanceof Error ? error.message : 'release guard failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
