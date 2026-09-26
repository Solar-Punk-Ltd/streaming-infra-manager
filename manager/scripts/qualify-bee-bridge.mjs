/**
 * Checks one Bee image for the chequebook bridge by hand, and prints its record.
 *
 * The manager reaches a Bee node's private API for a money-moving request by
 * running a small shell inside that node's own container, and that shell
 * depends on what the image carries. The manager runs this same check by
 * itself the first time a transfer goes through an image nothing has
 * qualified, and stores the result in bee_bridge_qualifications. This script
 * is for checking an image before that happens, or for adding a seed record to
 * PRODUCTION_BEE_BRIDGE_QUALIFICATIONS. It imports the check from the built
 * manager rather than restating it, so the two can never check different
 * things.
 *
 * Usage, after `pnpm --filter @streaming-infra-manager/api build`, against a
 * container already running the image:
 *
 *   node manager/scripts/qualify-bee-bridge.mjs --container <name> [--ssh <host>] [--id <record id>]
 *
 * It reads and never writes, and exits 1 when the image fails the check.
 */
import { execFileSync } from 'node:child_process';

const BUILT = new URL('../dist/domain/chequebook/', import.meta.url);

async function built(name) {
  try { return await import(new URL(name, BUILT).href); }
  catch { throw new Error('the built manager is missing: run pnpm --filter @streaming-infra-manager/api build first'); }
}

const { BEE_BRIDGE_CHECK_REVISION, beeBridgeCheckCommand, beeBridgeCheckEvidence, beeBridgeCheckVerdict } = await built('beeBridgeCheck.js');
const { DOCKER_BEE_BRIDGE_REVISION } = await built('dockerBeeBridge.js');

function options(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const container = value('--container');
  if (!container) throw new Error('give --container <name>, a container already running the image');
  return { container, ssh: value('--ssh'), id: value('--id') };
}

function docker(on, args) {
  const command = on.ssh ? ['ssh', ['-o', 'BatchMode=yes', on.ssh, ['docker', ...args].map(quote).join(' ')]] : ['docker', args];
  return execFileSync(command[0], command[1], { encoding: 'utf8' }).trim();
}

function quote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The check's own answer, or nothing when the exec could not run, which the verdict names as an unreadable answer. */
function checkAnswer(on) {
  try { return docker(on, ['exec', on.container, ...beeBridgeCheckCommand()]); }
  catch { return ''; }
}

function main() {
  const on = options(process.argv.slice(2));
  const engineVersion = docker(on, ['version', '--format', '{{.Server.Version}}']);
  const imageId = docker(on, ['inspect', '--format', '{{.Image}}', on.container]);
  const [os, architecture, variant] = docker(on, ['image', 'inspect', imageId, '--format', '{{.Os}} {{.Architecture}} {{.Variant}}']).split(' ');
  const imageRef = docker(on, ['inspect', '--format', '{{.Config.Image}}', on.container]);
  const platform = { os, architecture, variant: variant ?? '' };
  const verdict = beeBridgeCheckVerdict(checkAnswer(on));
  const { evidence, digest } = beeBridgeCheckEvidence({ imageId, engineVersion, platform, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION }, verdict);

  console.log('# evidence');
  console.log(JSON.stringify({ imageRef, ...evidence }, null, 2));
  if (verdict.failed) {
    console.error(`${imageRef} fails the bridge check: ${verdict.failed}. Transfers through it are refused.`);
    process.exitCode = 1;
    return;
  }
  const record = {
    id: on.id ?? `bee-${imageRef.split(':').pop()}-docker-${engineVersion}`,
    imageId,
    engineVersion,
    platform,
    bridgeRevision: 'DOCKER_BEE_BRIDGE_REVISION',
    harnessRevision: BEE_BRIDGE_CHECK_REVISION,
    evidenceDigest: digest,
    bridgeLifetimeSeconds: { min: 1, max: 270 },
    cleanupGraceMs: { min: 1, max: 10_000 },
    streamBounds: 'DOCKER_BEE_STREAM_BOUNDS',
  };
  console.log('# record, with the two named constants left for the catalogue to fill in');
  console.log(JSON.stringify(record, null, 2));
}

main();
