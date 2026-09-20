import { fileURLToPath } from 'node:url';

import { FixedReleaseAdapter, type FixedAdapterArguments } from './FixedReleaseAdapter.js';
import {
  installReleaseGuard,
  ReleaseGuardStore,
  type ReleaseGuardDeploymentTargets,
} from './ReleaseGuardStore.js';
import { submitPendingReceipt, validateReleaseReceiptDestination } from './ReleaseReceiptSubmitter.js';
import {
  digestReleaseCandidate,
  runReleaseTransition,
  runStackPreparation,
} from './ReleaseTransition.js';
import type {
  AdminReleaseRuntime,
  ReleaseRole,
  ReleaseSlot,
  StackReleaseOperation,
} from './ReleaseGuardTypes.js';

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
    const flags = parseFlags(rest, new Set([
      'state-root',
      'manager-project-name',
      'manager-mode',
      'manager-postgres-port',
      'manager-postgres-volume-name',
      'manager-web-port',
      'admin-project-name',
      'admin-postgres-volume-name',
      'admin-web-port',
      'uploader-profile',
      'uploader-port-slot',
      'uploader-services',
      'viewer-profile',
      'viewer-port-slot',
      'viewer-services',
      'fixture-network-name',
      'fixture-id',
    ]));
    await installReleaseGuard(required(flags, 'state-root'), undefined, installationTargets(flags));
    return 'release guard installed';
  }
  if (command === 'status') {
    const flags = parseFlags(rest, new Set(['state-root']));
    return new ReleaseGuardStore(required(flags, 'state-root')).releaseMode();
  }
  if (command === 'begin-legacy') {
    const flags = parseFlags(rest, new Set(['state-root']));
    const lease = await new ReleaseGuardStore(required(flags, 'state-root')).beginLegacyLease();
    return lease.mode === 'managed' ? 'managed' : `legacy:${lease.ownerToken}`;
  }
  if (command === 'begin-stack-legacy') {
    const flags = parseFlags(rest, new Set(['state-root', 'profile']));
    const lease = await new ReleaseGuardStore(required(flags, 'state-root'))
      .beginStackLegacyLease(required(flags, 'profile'));
    return `legacy:${lease.ownerToken}`;
  }
  if (command === 'finish-legacy') {
    const flags = parseFlags(rest, new Set(['state-root', 'owner-token']));
    await new ReleaseGuardStore(required(flags, 'state-root')).finishLegacyLease(required(flags, 'owner-token'));
    return 'legacy deployment lease released';
  }
  if (command === 'finish-stack-legacy') {
    const flags = parseFlags(rest, new Set(['state-root', 'owner-token']));
    await new ReleaseGuardStore(required(flags, 'state-root'))
      .finishLegacyLease(required(flags, 'owner-token'));
    return 'legacy stack deployment lease released';
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
  if (command === 'prepare-uploader' || command === 'update-uploader') {
    const isUpdate = command === 'update-uploader';
    const allowed = new Set([
      'state-root',
      'candidate-root',
      'work-root',
      'slot-id',
      'services',
      ...(isUpdate ? ['admin-url'] : []),
    ]);
    const flags = parseFlags(rest, allowed);
    const slot = releaseSlot('uploader', flags.get('slot-id'));
    const operation: StackReleaseOperation = {
      kind: isUpdate ? 'update' : 'prepare',
      mutatingServices: releaseServices(required(flags, 'services')),
    };
    const store = new ReleaseGuardStore(required(flags, 'state-root'));
    const adapter = new FixedReleaseAdapter(
      'uploader',
      required(flags, 'work-root'),
      await adapterArguments('uploader', store, operation),
    );
    if (!isUpdate) {
      await runStackPreparation({
        store,
        candidateRoot: required(flags, 'candidate-root'),
        slot,
        mutatingServices: operation.mutatingServices,
        adapter,
      });
      return 'uploader preparation verified';
    }
    const destination = receiptDestination(flags, env);
    await runReleaseTransition({
      store,
      candidateRoot: required(flags, 'candidate-root'),
      slot,
      operation: operation as Extract<StackReleaseOperation, { kind: 'update' }>,
      adapter,
    });
    await submitPendingReceipt({ store, slot, ...destination });
    return 'uploader subset release verified and acknowledged';
  }
  if (!command || !ROLES.has(command as ReleaseRole)) throw new Error('release guard command is invalid');
  const role = command as ReleaseRole;
  const allowed = new Set([
    'state-root',
    'candidate-root',
    'work-root',
    'admin-url',
    'slot-id',
    ...(role === 'admin' ? ['managed-lifecycle-version', 'managed-uploader-id'] : []),
  ]);
  const flags = parseFlags(rest, allowed);
  const slot = releaseSlot(role, flags.get('slot-id'));
  const runtime = role === 'admin' ? adminRuntime(flags) : undefined;
  const destination = receiptDestination(flags, env);
  const store = new ReleaseGuardStore(required(flags, 'state-root'));
  const adapterArgs = await adapterArguments(role, store, undefined, runtime);
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

async function adapterArguments(
  role: ReleaseRole,
  store: ReleaseGuardStore,
  operation?: StackReleaseOperation,
  runtime?: AdminReleaseRuntime,
): Promise<FixedAdapterArguments> {
  const fixtureNetwork = await store.fixtureNetwork();
  return {
    target: await store.deploymentTarget(role),
    ...(fixtureNetwork ? { fixtureNetwork } : {}),
    ...(operation ? { operation } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

function adminRuntime(flags: Map<string, string>): AdminReleaseRuntime {
  const version = flags.get('managed-lifecycle-version');
  const uploaderId = flags.get('managed-uploader-id');
  if (version === undefined && uploaderId === undefined) {
    return { managedLifecycleVersion: null, uploaderId: null };
  }
  if (version !== '1' || uploaderId === undefined || !UPLOADER_ID.test(uploaderId)) {
    throw new Error('admin managed runtime assignment is invalid');
  }
  return { managedLifecycleVersion: 1, uploaderId };
}

function releaseServices(value: string): string[] {
  const services = value.split(',');
  const sorted = [...services].sort();
  if (
    services.length === 0 ||
    services.length > 32 ||
    services.some((service) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(service)) ||
    new Set(services).size !== services.length ||
    services.some((service, index) => service !== sorted[index])
  ) {
    throw new Error('release guard services are invalid');
  }
  return services;
}

function installationTargets(flags: Map<string, string>): ReleaseGuardDeploymentTargets {
  const targets: ReleaseGuardDeploymentTargets = {};
  for (const role of ['manager', 'admin'] as const) {
    const projectName = flags.get(`${role}-project-name`);
    const postgresVolumeName = flags.get(`${role}-postgres-volume-name`);
    const webPortText = flags.get(`${role}-web-port`);
    const mode = role === 'manager' ? flags.get('manager-mode') : undefined;
    const postgresPortText = role === 'manager' ? flags.get('manager-postgres-port') : undefined;
    const values = role === 'manager'
      ? [mode, projectName, postgresVolumeName, postgresPortText, webPortText]
      : [projectName, postgresVolumeName, webPortText];
    const supplied = values.filter((value) => value !== undefined).length;
    if (supplied === 0) continue;
    if (supplied !== values.length) throw new Error(`release guard ${role} target is incomplete`);
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName!) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(postgresVolumeName!)) {
      throw new Error(`release guard ${role} target is invalid`);
    }
    if (!/^[1-9]\d*$/.test(webPortText!)) throw new Error(`release guard ${role} target is invalid`);
    const webPort = Number(webPortText);
    if (!Number.isSafeInteger(webPort) || webPort > 65_535) throw new Error(`release guard ${role} target is invalid`);
    if (role === 'admin') {
      targets.admin = { projectName: projectName!, postgresVolumeName: postgresVolumeName!, webPort };
      continue;
    }
    if ((mode !== 'production' && mode !== 'isolated') || !/^[1-9]\d*$/.test(postgresPortText!)) {
      throw new Error('release guard manager target is invalid');
    }
    const postgresPort = Number(postgresPortText);
    if (!Number.isSafeInteger(postgresPort) || postgresPort > 65_535) {
      throw new Error('release guard manager target is invalid');
    }
    targets.manager = {
      mode,
      projectName: projectName!,
      postgresVolumeName: postgresVolumeName!,
      postgresPort,
      webPort,
    };
  }
  for (const role of ['uploader', 'viewer'] as const) {
    const profile = flags.get(`${role}-profile`);
    const portSlotText = flags.get(`${role}-port-slot`);
    const servicesText = flags.get(`${role}-services`);
    const values = [profile, portSlotText, servicesText];
    const supplied = values.filter((value) => value !== undefined).length;
    if (supplied === 0) continue;
    if (supplied !== values.length || !/^\d+$/.test(portSlotText!)) {
      throw new Error(`release guard ${role} target is incomplete`);
    }
    targets[role] = {
      profile: profile!,
      portSlot: Number(portSlotText),
      target: 'local',
      services: servicesText!.split(','),
    };
  }
  const fixtureNetworkName = flags.get('fixture-network-name');
  const fixtureId = flags.get('fixture-id');
  if ((fixtureNetworkName === undefined) !== (fixtureId === undefined)) {
    throw new Error('release guard fixture network target is incomplete');
  }
  if (fixtureNetworkName && fixtureId) {
    targets.fixtureNetwork = { name: fixtureNetworkName, fixtureId };
  }
  return targets;
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
