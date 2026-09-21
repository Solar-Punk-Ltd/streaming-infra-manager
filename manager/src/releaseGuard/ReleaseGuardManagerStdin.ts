import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { validateReleaseReceiptDestination } from './ReleaseReceiptSubmitter.js';

const MAX_FRAME_BYTES = 24 * 1024;
const TOKEN = /^[\x21-\x7e]{32,8192}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export interface ManagerStdinFrame {
  receiptToken: string;
  receiptAdminUrl: string;
  candidateDigest: string;
  postgresPassword: string;
  managedUploaderProfile: string;
  adminApiUrl: string;
  adminApiToken: string;
}

/** Reads the fixed secret frame without writing any field to disk or output. */
export async function readManagerStdinFrame(input: NodeJS.ReadableStream): Promise<ManagerStdinFrame> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += value.length;
    if (bytes > MAX_FRAME_BYTES) throw new Error('manager release input is oversized');
    chunks.push(value);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('manager release input is invalid');
  }
  const fields = text.split('\0');
  if (fields.length !== 8 || fields[7] !== '') {
    throw new Error('manager release input must contain exactly seven fields');
  }
  const [
    receiptToken,
    receiptAdminUrl,
    candidateDigest,
    postgresPassword,
    managedUploaderProfile,
    adminApiUrl,
    adminApiToken,
  ] = fields;
  if (!receiptToken || !TOKEN.test(receiptToken)) throw new Error('manager release token is invalid');
  if (!receiptAdminUrl || !candidateDigest || !DIGEST.test(candidateDigest)) {
    throw new Error('manager release input is invalid');
  }
  if (!postgresPassword || Buffer.byteLength(postgresPassword) > 8192) {
    throw new Error('manager release database input is invalid');
  }
  if (!managedUploaderProfile || !PROFILE.test(managedUploaderProfile)) {
    throw new Error('manager release profile input is invalid');
  }
  if (!adminApiToken || !TOKEN.test(adminApiToken)) throw new Error('manager admin token is invalid');
  validateReleaseReceiptDestination(receiptAdminUrl, receiptToken);
  validateReleaseReceiptDestination(adminApiUrl, adminApiToken);
  return {
    receiptToken,
    receiptAdminUrl,
    candidateDigest,
    postgresPassword,
    managedUploaderProfile,
    adminApiUrl,
    adminApiToken,
  };
}

export function managerGuardInvocation(
  home: string,
  installationRoot: string,
  frame: ManagerStdinFrame,
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const expectedInstallationRoot = join(home, '.local');
  if (
    !isAbsolute(home) ||
    normalize(home) !== home ||
    !isAbsolute(installationRoot) ||
    normalize(installationRoot) !== installationRoot ||
    installationRoot !== expectedInstallationRoot
  ) {
    throw new Error('manager release installation is invalid');
  }
  const codeRoot = join(installationRoot, 'lib/streaming-release-guard/current');
  const stateRoot = join(installationRoot, 'state/streaming-release-guard');
  const candidateRoot = join(home, 'streaming-infra-manager-releases/manager', frame.candidateDigest);
  const workRoot = join(stateRoot, 'work', `manager-${frame.candidateDigest}`);
  const environmentNames = ['PATH', 'HOME', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
  const env = Object.fromEntries(
    environmentNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  env.POSTGRES_PASSWORD = frame.postgresPassword;
  env.SRS_LIFECYCLE_VERSION = '1';
  env.SRS_MANAGED_UPLOADER_PROFILE = frame.managedUploaderProfile;
  env.ADMIN_API_TOKEN = frame.adminApiToken;
  env.ADMIN_API_URL = frame.adminApiUrl;
  env.RELEASE_GUARD_ADMIN_TOKEN = frame.receiptToken;
  env.RELEASE_GUARD_ADMIN_URL = frame.receiptAdminUrl;
  return {
    argv: [
      join(codeRoot, 'ReleaseGuardCli.js'),
      'manager',
      '--state-root', stateRoot,
      '--candidate-root', candidateRoot,
      '--work-root', workRoot,
    ],
    env,
  };
}

async function main(): Promise<void> {
  try {
    const frame = await readManagerStdinFrame(process.stdin);
    const installationRoot = resolve(import.meta.dirname, '../../..');
    const invocation = managerGuardInvocation(homedir(), installationRoot, frame);
    const child = spawn(process.execPath, invocation.argv, {
      env: invocation.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveRun, rejectRun) => {
      child.once('error', () => rejectRun(new Error('manager release guard could not start')));
      child.once('close', (code, signal) => resolveRun({ code, signal }));
    });
    if (result.signal) throw new Error(`manager release guard was terminated by ${result.signal}`);
    if (result.code !== 0) throw new Error(`manager release guard failed with exit ${result.code ?? 'unknown'}`);
  } catch (error) {
    process.stderr.write(`REFUSED: ${error instanceof Error ? error.message : 'manager release input failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
