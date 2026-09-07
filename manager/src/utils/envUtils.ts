import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abrLadderEnvValue,
  applicableEngineSettings,
  beePublishersProblem,
  beeUrlProblem,
  effectiveEngineDefaults,
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
  return created;
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (pattern.test(text)) {
    // A replacer function, not the string: as a replacement string, `$&`,
    // `` $` ``, `$'` and `$1` are substitution patterns, so a value containing
    // one would be rewritten with the text it matched. `$` is legal in a URL
    // path and `beeUrlProblem` accepts it, so BEE_URL=http://host:1633/$&
    // would otherwise be written out as BEE_URL=http://host:1633/BEE_URL=<old>.
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
   * An explicit bee API URL. Written only when there is no local bee-uploader —
   * deploy.sh's resolve_bee_url overrides this file's value whenever there is.
   */
  beeUrl?: string | null;

  /**
   * SRS's SRT listener passphrase.
   *
   * Left absent, the base .env's own SRT_PASSPHRASE survives the copy below and
   * applies — which is how every deployment behaved before this was settable per
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
   */
  stackSecrets?: StackSecrets;

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
   * service list — not from whatever subset is being deployed right now.
   *
   * deploy.sh's resolve_bee_url needs this and cannot work it out: the service
   * filter tells it which services this invocation was asked for, and the
   * manager deploys a held-back uploader alone once a batch is bought, which
   * looks identical to a profile that has no Bee node at all. Getting that
   * wrong either overwrites an explicit external BEE_URL or leaves a local
   * uploader pointed at the base env's address.
   */
  localBeeUploader?: boolean;
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
  // uploader refuses to start unless the publishers cover the ladder exactly —
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
    // blanking it stops the container at config load — even though `config.stamp`
    // is only ever read by `BeePublisherPool.single()`, which pool mode does not
    // call. Making STAMP conditional belongs upstream; until then a stray value
    // is inert and an empty one is fatal.
  }

  const beeUrl = values.beeUrl?.trim();
  if (beeUrl && !publishers) {
    const problem = beeUrlProblem(beeUrl);
    if (problem) {
      throw new Error(`refusing to write BEE_URL to the env file: ${problem}`);
    }
    contents = upsertEnvLine(contents, 'BEE_URL', beeUrl);
  }

  // `engines/srs/entrypoint.sh` splices this into srs.conf through a sed s///
  // expression without validating it, so a stray `/` writes a corrupt config and
  // a stray `&` a surprising one — either way a container that crash-loops under
  // `restart: unless-stopped`. The request schema and a CHECK constraint both
  // refuse those already; this is the last gate before the value leaves the
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
    defaults: effectiveEngineDefaults(values.engine, parseEnvText(baseContents))
      .values,
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

  const path = profileEnvPath(root, name);
  writeFileSync(path, contents, 'utf8');
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
