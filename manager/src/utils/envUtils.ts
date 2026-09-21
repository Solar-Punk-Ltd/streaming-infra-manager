import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abrLadderEnvValue,
  applicableEngineSettings,
  beePublishersProblem,
  beeUrlProblem,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  type NodeMode,
  type RpcEndpointSource,
  rpcEndpointProblem,
  effectiveEngineDefaults,
  ENGINE_CONFIG_ENV_KEYS,
  ENGINE_CONFIG_FILE_RE,
  type EngineName,
  type EngineSettings,
  engineSettingsEnv,
  engineSettingsProblem,
  isValidSrtPassphrase,
  normalizeBeePublishers,
  OME_SERVICE,
  SRT_PASSPHRASE_MESSAGE,
} from '@streaming-infra-manager/common';

import {
  STACK_SECRET_KEY_RE,
  STACK_SECRET_VALUE_RE,
  type StackSecrets,
} from '../domain/versions/stackSecrets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: the swarm-hls-stream submodule sits next to the manager source tree.
// On the deploy server the submodule lives outside the image (bind-mounted
// from the host) so the path differs from the in-image one. SHLS_ROOT lets
// docker-compose.yml point at the bind-mount without code changes.
//
// This is the bundled version's checkout. Added versions live under their own
// roots, so every function here takes the root it is working in rather than
// reading this one.
export const BUNDLED_STACK_ROOT =
  process.env.SHLS_ROOT ?? resolve(HERE, '../../swarm-hls-stream');

/**
 * Every env file the manager writes, owner only.
 *
 * A deployment's file holds every secret it was given, generated or otherwise,
 * and the version's base .env, which that file is a copy of, holds
 * API_AUTH_TOKEN, PUBLISH_KEY_SECRET and STREAM_KEY. The api container runs as
 * root, so a mode left to the umask, or to the checked-in sample the base file
 * is copied from, is a file every account on the host can read.
 */
const ENV_FILE_MODE = 0o600;

export function profileEnvPath(root: string, name: string): string {
  return join(root, `.env.${name}`);
}

export function baseEnvPath(root: string): string {
  return join(root, '.env');
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, 'utf8'));
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function parseBaseEnv(root: string): Record<string, string> {
  return parseEnvFile(baseEnvPath(root));
}

export function engineEnvPath(root: string, engine: EngineName): string {
  return join(root, 'engines', engine, '.env');
}

/** Creates the engine env file a local guarded profile deploy consumes. */
export async function bootstrapEngineProfileEnv(
  root: string,
  engine: EngineName,
  profile: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) {
    throw new Error('engine profile env name is invalid');
  }
  const engineRoot = join(root, 'engines', engine);
  const engineRootStat = await lstat(engineRoot).catch(() => null);
  if (!engineRootStat?.isDirectory() || engineRootStat.isSymbolicLink()) {
    throw new Error(`the ${engine} engine directory is invalid`);
  }
  const destination = join(engineRoot, `.env.${profile}`);
  if (!existsSync(destination)) {
    const base = engineEnvPath(root, engine);
    const sample = `${base}.sample`;
    const source = existsSync(base) ? base : sample;
    const sourceStat = await lstat(source).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`the ${engine} engine env source is missing`);
    }
    await copyFile(source, destination);
  }
  const destinationStat = await lstat(destination).catch(() => null);
  if (!destinationStat?.isFile() || destinationStat.isSymbolicLink()) {
    throw new Error(`the ${engine} engine profile env is invalid`);
  }
  chmodSync(destination, ENV_FILE_MODE);
  return destination;
}

/**
 * The engine's own env file of a checkout. deploy.sh reads it beside the base
 * env and lets the root file win, so a key the manager writes at the root
 * decides and a key it leaves out is decided here.
 */
export function parseEngineEnv(root: string, engine: EngineName): Record<string, string> {
  return parseEnvFile(engineEnvPath(root, engine));
}

/** A file the checkout ships as a sample, and the live file copied from it. */
export interface BootstrapPair {
  src: string;
  dst: string;
}

export function bootstrapPairsFor(root: string): readonly BootstrapPair[] {
  return [
    { src: join(root, '.env.sample'), dst: join(root, '.env') },
    {
      src: join(root, 'deploy', 'config.sample.json'),
      dst: join(root, 'deploy', 'config.json'),
    },
  ];
}

/** Copies the samples a checkout needs, and answers what it had to create. */
export async function bootstrapStackDefaults(root: string): Promise<string[]> {
  const created: string[] = [];
  for (const { src, dst } of bootstrapPairsFor(root)) {
    if (!existsSync(dst) && existsSync(src)) {
      await copyFile(src, dst);
      created.push(dst);
    }
  }
  // A copy keeps the mode of the file it came from, and a checked-in sample is
  // 0644. Narrowed rather than set on the copy alone, because a checkout an
  // older manager bootstrapped is still carrying the sample's mode.
  // deploy/config.json is left as it is: it holds paths and ports.
  const base = baseEnvPath(root);
  if (existsSync(base)) chmodSync(base, ENV_FILE_MODE);
  return created;
}

const LINE_BREAK_RE = /[\r\n]/;

/**
 * Writes one `KEY=value` line, and refuses a value that would write two.
 *
 * The refusal is the one gate every field passes, in front of the writer rather
 * than on each field. `.env.<profile>` is read a line at a time, by docker
 * compose as its env file and by the stack's deploy script as its defaults, so
 * a value carrying a line break is a second assignment and the key it assigns
 * belongs to whoever wrote the value. A field that checks its own shape is then
 * covered twice, and a field added later is covered without anybody remembering
 * to cover it.
 */
function upsertEnvLine(text: string, key: string, value: string): string {
  if (LINE_BREAK_RE.test(value)) {
    throw new Error(
      `refusing to write ${key} to the env file: a value with a line break becomes a second line, and a second line is a second key`,
    );
  }
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (pattern.test(text)) {
    // A replacer function, not the string: as a replacement string, `$&`,
    // `` $` ``, `$'` and `$1` are substitution patterns, so a value containing
    // one would be rewritten with the text it matched. Every address rule
    // refuses a `$` today, and the replacer is what keeps that from mattering
    // for a value that reaches this writer by another path.
    return text.replace(pattern, () => line);
  }
  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return `${text}${needsNewline ? '\n' : ''}${line}\n`;
}

export interface ProfileEnvValues {
  engine: EngineName;
  stampId?: string | null;
  /** A pasted BEE_PUBLISHERS: publish to an ABR node pool rather than STAMP. */
  beePublishers?: string | null;
  /**
   * An explicit bee API URL. Written only when there is no local bee-uploader,
   * deploy.sh's resolve_bee_url overrides this file's value whenever there is.
   */
  beeUrl?: string | null;

  /**
   * SRS's SRT listener passphrase.
   *
   * Left absent, the base .env's own SRT_PASSPHRASE survives the copy below and
   * applies, which is how every deployment behaved before this was settable per
   * profile, and what clearing the field goes back to.
   */
  srtPassphrase?: string | null;

  /**
   * The uploader's STREAM_KEY: the private key it signs the feed with.
   *
   * It reaches the container through this file and no other way. Passed as a
   * `--private-key=` script argument it appeared in the manager's own logs and
   * in the process table for the whole run, readable by every user on the host.
   * Left absent, the base .env's own STREAM_KEY applies, as with the passphrase.
   */
  streamKey?: string | null;

  /**
   * The generated secrets the deployment's stack version requires, for
   * example API_AUTH_TOKEN and SRS_WEBHOOK_TOKEN on main-v3. Written at the
   * root, where compose interpolates both the uploader's and the engine's copy
   * from, and where deploy.sh lets the root file win over the engine env.
   *
   * A key the version's own settings already set is absent from this map, and
   * that absence is what applies it: the copy below carries the version's line
   * unchanged, as with the passphrase and the stream key above.
   */
  stackSecrets?: StackSecrets;

  /**
   * What the version's entrypoints fall back to for an unset engine setting,
   * from its contract. The keyframe rule is checked against these where the
   * base env sets nothing, because that is the value the container starts with.
   */
  stackEngineDefaults?: EngineSettings;

  /**
   * The deployment's own engine config file on the host, which the stack's
   * compose override mounts into the engine container when the key is set.
   * Absent, the key is left out and the version's template runs.
   */
  engineConfigFile?: string | null;

  /**
   * Engine settings this profile overrides, by env key. An absent key is left
   * out of the file for the same reason an absent passphrase is: the base .env
   * still decides it.
   */
  engineSettings?: EngineSettings | null;

  omeSrtPort?: number;
  omeHlsPort?: number;
  /**
   * Whether this profile runs a `bee-uploader` of its own, from its full
   * service list, not from whatever subset is being deployed right now.
   *
   * deploy.sh's resolve_bee_url needs this and cannot work it out: the service
   * filter tells it which services this invocation was asked for, and the
   * manager deploys a held-back uploader alone once a batch is bought, which
   * looks identical to a profile that has no Bee node at all. Getting that
   * wrong either overwrites an explicit external BEE_URL or leaves a local
   * uploader pointed at the base env's address.
   */
  localBeeUploader?: boolean;
  /**
   * The chain endpoint this deployment stores for itself, which applies when
   * its source is `custom` and is ignored otherwise.
   */
  rpcEndpoint?: string | null;
  /**
   * Where this deployment's endpoint comes from. Absent is read off the address
   * above, which is how every deployment written before the source existed is
   * read.
   */
  rpcEndpointSource?: RpcEndpointSource | null;
  /** The manager's own endpoint, BEE_RPC_ENDPOINT, which `manager` names. */
  managerRpcEndpoint?: string | null;
  /**
   * The mode this deployment's Bee gateway runs in, or nothing when it runs no
   * gateway. Worked out from its services and its mode by the caller, as
   * `localBeeUploader` is.
   */
  gatewayMode?: NodeMode | null;
  /** Version-one lifecycle reporting, bound to this deployment's persisted identity. */
  managedSrs?: {
    lifecycleVersion: 1;
    uploaderId: string;
  } | null;
}

/**
 * The address this deployment's Bee nodes reach the chain through, or null to
 * leave the stack's own value standing.
 *
 * A source that names a value and finds none stops the deploy rather than
 * writing no line. The difference is invisible in the file either way, and the
 * silent version moves the deployment onto the stack's public RPC, which is the
 * endpoint an operator who configured their own is trying to get off. It
 * happens whenever BEE_RPC_ENDPOINT is removed from a manager that has
 * deployments on it.
 */
function resolveRpcEndpoint(
  source: RpcEndpointSource,
  values: ProfileEnvValues,
): string | null {
  if (source === 'stack') return null;
  const named =
    source === 'manager' ? values.managerRpcEndpoint : values.rpcEndpoint;
  const address = named?.trim();
  if (!address) {
    throw new Error(
      source === 'manager'
        ? 'refusing to write RPC_ENDPOINT to the env file: this deployment takes the manager’s chain endpoint and the manager has none. Set BEE_RPC_ENDPOINT, or move the deployment onto an endpoint of its own.'
        : 'refusing to write RPC_ENDPOINT to the env file: this deployment names a chain endpoint of its own and none is stored',
    );
  }
  return address;
}

// deploy.sh switches ENV_FILE to .env.<profile> when present and uses it as
// compose's --env-file, so this must be a full copy of base .env with the
// per-profile keys upserted, not just the overridden lines.
export function writeProfileEnv(
  root: string,
  name: string,
  values: ProfileEnvValues,
): string {
  const basePath = baseEnvPath(root);
  const baseContents = existsSync(basePath)
    ? readFileSync(basePath, 'utf8')
    : '';
  let contents = baseContents;

  contents = upsertEnvLine(contents, 'ENGINE', values.engine);

  const managedSrs = values.managedSrs;
  if (managedSrs && !/^[A-Za-z0-9_.:-]{1,200}$/.test(managedSrs.uploaderId)) {
    throw new Error(
      'refusing to write SRS_UPLOADER_ID outside its bounded identity grammar',
    );
  }
  contents = upsertEnvLine(
    contents,
    'SRS_LIFECYCLE_VERSION',
    managedSrs ? String(managedSrs.lifecycleVersion) : '',
  );
  contents = upsertEnvLine(
    contents,
    'SRS_UPLOADER_ID',
    managedSrs?.uploaderId ?? '',
  );

  // Stated explicitly both ways rather than only when false: this file is a
  // fresh copy of the base .env each deploy, and leaving the key absent would
  // let a base-env value decide it.
  if (values.localBeeUploader !== undefined) {
    contents = upsertEnvLine(
      contents,
      'LOCAL_BEE_UPLOADER',
      values.localBeeUploader ? 'true' : 'false',
    );
  }

  const stamp = values.stampId?.replace(/^0x/, '').trim();
  if (stamp) {
    if (!/^[0-9a-fA-F]+$/.test(stamp)) {
      throw new Error('refusing to write a non-hex STAMP to the env file');
    }
    contents = upsertEnvLine(contents, 'STAMP', stamp);
  }

  // A pool-backed uploader publishes to the ABR node pool's nodes rather than to
  // this profile's own bee-uploader. ABR_ENABLED and ABR_LADDER go here too, not
  // into engines/srs/.env.<profile>: the root env wins over it in deploy.sh, both
  // srs and the uploader read them from the compose environment, and the
  // uploader refuses to start unless the publishers cover the ladder exactly,
  // so the two are written by one hand, from one definition.
  // Normalised here too, not only in the schema: rows written before the
  // schema canonicalised the value still hold whatever was pasted, and this is
  // the last point before it becomes a line in a file compose has to parse.
  const publishers = normalizeBeePublishers(values.beePublishers?.trim());
  if (publishers) {
    const problem = beePublishersProblem(publishers);
    if (problem) {
      throw new Error(
        `refusing to write BEE_PUBLISHERS to the env file: ${problem}`,
      );
    }
    if (values.engine === OME_SERVICE) {
      throw new Error(
        'BEE_PUBLISHERS requires the srs engine — the ABR ladder is SRS-only',
      );
    }
    contents = upsertEnvLine(contents, 'BEE_PUBLISHERS', publishers);
    contents = upsertEnvLine(contents, 'ABR_ENABLED', 'true');
    contents = upsertEnvLine(contents, 'ABR_LADDER', abrLadderEnvValue());
    // STAMP is deliberately left alone, tempting though it is to clear: a
    // pool-backed uploader owns no batch, and .env.<profile> is a full copy of
    // the base .env, so whatever STAMP was configured there rides along and
    // belongs to someone else. But the uploader declares `stamp: required(…)`
    // unconditionally and its `required()` throws on an empty string, so
    // blanking it stops the container at config load, even though `config.stamp`
    // is only ever read by `BeePublisherPool.single()`, which pool mode does not
    // call. Making STAMP conditional belongs upstream. Until then a stray value
    // is inert and an empty one is fatal.
  }

  // Every Bee node reads this, and the only place to set it used to be the
  // stack version, so every deployment on a version shared one endpoint. The
  // shipped default is a public RPC that answered one node 4568 HTTP 429s in
  // two hours on 2026-09-15, so a deployment has to be able to name its own or
  // take the manager's. The stack's own value standing is what every deployment
  // did before any of this existed, and it is what `stack` still means.
  // A caller that names no source is read off the address alone, which is how
  // every deployment written before the source existed is read. The manager's
  // endpoint is never implied here: the orchestrator always names the source,
  // and nothing else writes this file.
  const rpcEndpointSource =
    values.rpcEndpointSource ??
    (values.rpcEndpoint?.trim()
      ? CUSTOM_RPC_ENDPOINT_SOURCE
      : DEFAULT_RPC_ENDPOINT_SOURCE);
  const rpcEndpoint = resolveRpcEndpoint(rpcEndpointSource, values);
  if (rpcEndpoint) {
    const problem = rpcEndpointProblem(rpcEndpoint);
    if (problem) {
      throw new Error(
        `refusing to write RPC_ENDPOINT to the env file: ${problem}`,
      );
    }
    contents = upsertEnvLine(contents, 'RPC_ENDPOINT', rpcEndpoint);
  }

  // The stack starts its gateway with an empty endpoint and SWAP off, which is
  // what makes that node ultra-light. A gateway an operator put on the chain
  // needs both said the other way, and it is the same endpoint the rest of the
  // deployment reaches the chain through.
  //
  // Both modes are stated rather than only the light one, for the reason
  // LOCAL_BEE_UPLOADER is stated both ways: this file is a fresh copy of the
  // base .env each deploy, so a host-wide value left there would decide the
  // gateway's chain for every deployment that says nothing, and turn an
  // ultra-light gateway light on its next deploy.
  if (values.gatewayMode === 'light') {
    if (!rpcEndpoint) {
      throw new Error(
        'refusing to write BEE_GATEWAY_RPC_ENDPOINT to the env file: a light gateway needs a chain endpoint and this deployment takes the stack’s, which for a gateway is none',
      );
    }
    contents = upsertEnvLine(contents, 'BEE_GATEWAY_RPC_ENDPOINT', rpcEndpoint);
    contents = upsertEnvLine(contents, 'BEE_GATEWAY_SWAP_ENABLE', 'true');
  } else if (values.gatewayMode === 'ultra-light') {
    contents = upsertEnvLine(contents, 'BEE_GATEWAY_RPC_ENDPOINT', '');
    contents = upsertEnvLine(contents, 'BEE_GATEWAY_SWAP_ENABLE', 'false');
  }

  const beeUrl = values.beeUrl?.trim();
  if (beeUrl && !publishers) {
    const problem = beeUrlProblem(beeUrl);
    if (problem) {
      throw new Error(`refusing to write BEE_URL to the env file: ${problem}`);
    }
    contents = upsertEnvLine(contents, 'BEE_URL', beeUrl);
  }

  // A deployment that runs no Bee node and names no address has nowhere to
  // publish, and the request refuses that now. This is the same refusal for a
  // row stored before it did. The file is a full copy of the base .env, which
  // is copied from the stack's .env.sample, and that carries
  // BEE_URL=http://localhost:1633: inside the uploader container, the container
  // itself. deploy.sh refuses LOCAL_BEE_UPLOADER=false beside an EMPTY BEE_URL
  // and says what to set, so writing the key empty is what turns a crash loop
  // into that message. A pool-backed uploader is left alone: BEE_PUBLISHERS is
  // what it reads and BEE_URL never applies to it.
  if (values.localBeeUploader === false && !beeUrl && !publishers) {
    contents = upsertEnvLine(contents, 'BEE_URL', '');
  }

  // `engines/srs/entrypoint.sh` splices this into srs.conf through a sed s///
  // expression without validating it, so a stray `/` writes a corrupt config and
  // a stray `&` a surprising one. Either way a container that crash-loops under
  // `restart: unless-stopped`. The request schema and a CHECK constraint both
  // refuse those already. This is the last gate before the value leaves the
  // manager, and covers a row written by anything but those two paths.
  const passphrase = values.srtPassphrase?.trim();
  if (passphrase) {
    if (!isValidSrtPassphrase(passphrase)) {
      throw new Error(
        `refusing to write SRT_PASSPHRASE: ${SRT_PASSPHRASE_MESSAGE}`,
      );
    }
    contents = upsertEnvLine(contents, 'SRT_PASSPHRASE', passphrase);
  }

  // The request schema already refuses anything but 0x + 64 hex. Checked again
  // here because this is the last point before the value becomes a line in a
  // file compose parses, and a row written by any other path reaches it too.
  const streamKey = values.streamKey?.trim();
  if (streamKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(streamKey)) {
      throw new Error(
        'refusing to write STREAM_KEY: expected 0x followed by 64 hex characters',
      );
    }
    contents = upsertEnvLine(contents, 'STREAM_KEY', streamKey);
  }

  // Validated here as well as in the settings route, because this is the last
  // point before the values leave the manager and both entrypoints splice them
  // into a `sed` expression without a guard of their own. `abr` follows
  // BEE_PUBLISHERS, which is the same thing that turns ABR_ENABLED on above.
  //
  // Only over the keys this deployment still reads. A rung setting stored while
  // the ladder was on and left behind when it was turned off is skipped, not
  // refused: refusing would fail every deploy from here on over a value no
  // drawer shows and nobody can remove. A key that does not apply in a new
  // request is still refused, by the request schema and by the settings route.
  const abr = Boolean(publishers);
  const engineSettings = applicableEngineSettings(
    values.engine,
    values.engineSettings ?? {},
    { abr },
  );
  // Against the defaults this host actually falls back to, not the stack's own:
  // an unset key is left out of the file below and whatever the base .env says
  // stands, so checking a pair against the stack values refuses a deployment
  // that would start and passes one that would not.
  const settingsProblem = engineSettingsProblem(values.engine, engineSettings, {
    abr,
    defaults: effectiveEngineDefaults(
      values.engine,
      parseEnvText(baseContents),
      values.stackEngineDefaults ?? {},
    ).values,
  });
  if (settingsProblem) {
    throw new Error(
      `refusing to write the engine settings to the env file: ${settingsProblem}`,
    );
  }
  for (const [key, value] of Object.entries(
    engineSettingsEnv(values.engine, engineSettings, { abr }),
  )) {
    contents = upsertEnvLine(contents, key, value);
  }

  // Generated by the manager and checked against the shape it generates, so
  // nothing that is not one of its own values can reach this file through
  // the column. A key that fails is a bug, not an operator error.
  for (const [key, value] of Object.entries(values.stackSecrets ?? {})) {
    if (!STACK_SECRET_KEY_RE.test(key) || !STACK_SECRET_VALUE_RE.test(value)) {
      throw new Error(
        `refusing to write ${key} to the env file: not a secret this manager generated`,
      );
    }
    contents = upsertEnvLine(contents, key, value);
  }

  if (values.engine === OME_SERVICE) {
    if (values.omeSrtPort) {
      contents = upsertEnvLine(
        contents,
        'OME_SRT_PORT',
        String(values.omeSrtPort),
      );
    }
    if (values.omeHlsPort) {
      contents = upsertEnvLine(
        contents,
        'OME_HLS_PORT',
        String(values.omeHlsPort),
      );
    }
  }

  // An absolute path the manager built from the profile name, checked as one
  // because it becomes a bind mount source: a relative path would be resolved
  // against the compose file, and a quote or a space would end the mount.
  const configFile = values.engineConfigFile?.trim();
  if (configFile) {
    if (!ENGINE_CONFIG_FILE_RE.test(configFile)) {
      throw new Error(
        `refusing to write ${ENGINE_CONFIG_ENV_KEYS[values.engine]}: ${configFile} is not a plain absolute path`,
      );
    }
    contents = upsertEnvLine(
      contents,
      ENGINE_CONFIG_ENV_KEYS[values.engine],
      configFile,
    );
  }

  const path = profileEnvPath(root, name);
  writeFileSync(path, contents, { encoding: 'utf8', mode: ENV_FILE_MODE });
  // The mode argument applies only to a file this call creates, and every
  // deploy after the first one rewrites a file that is already there, so a
  // deployment first written by an older manager keeps its wider mode without
  // this.
  chmodSync(path, ENV_FILE_MODE);
  return path;
}

export function deleteProfileEnv(root: string, name: string): boolean {
  const path = profileEnvPath(root, name);

  if (!existsSync(path)) {
    return false;
  }

  unlinkSync(path);
  return true;
}
