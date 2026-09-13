/**
 * Qualifies one Bee image for the chequebook bridge, and prints its record.
 *
 * The manager reaches a Bee node's private API for a money-moving request by
 * running a small shell inside that node's own container, because an exec by
 * container id can only reach that container where a call to a port can be
 * answered by anything. That shell depends on what the image carries, so
 * `PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` names the exact images somebody
 * checked. This is the check. Until it is run for an image, transfers through
 * that image refuse, which is the whole of why the list ships empty.
 *
 * Usage, against a container already running the image:
 *
 *   node manager/scripts/qualify-bee-bridge.mjs --container <name> [--ssh <host>] [--id <record id>]
 *
 * It reads and never writes. Paste what it prints into the catalogue.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Everything the bridge script names by absolute path. */
const REQUIRED_BINARIES = ['/usr/bin/env', '/usr/bin/timeout', '/bin/bash', '/usr/bin/cat'];
/** Nothing listens here, so bash saying "connection refused" is bash having the feature. */
const CLOSED_PORT = 9;

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

function inside(on, script) {
  return docker(on, ['exec', on.container, 'sh', '-c', script]);
}

function main() {
  const on = options(process.argv.slice(2));

  const engineVersion = docker(on, ['version', '--format', '{{.Server.Version}}']);
  const imageId = docker(on, ['inspect', '--format', '{{.Image}}', on.container]);
  const [os, architecture, variant] = docker(on, ['image', 'inspect', imageId, '--format', '{{.Os}} {{.Architecture}} {{.Variant}}']).split(' ');
  const imageRef = docker(on, ['inspect', '--format', '{{.Config.Image}}', on.container]);

  const binaries = Object.fromEntries(REQUIRED_BINARIES.map((path) => [path, inside(on, `[ -x ${path} ] && echo yes || echo no`)]));
  const missing = REQUIRED_BINARIES.filter((path) => binaries[path] !== 'yes');
  if (missing.length) throw new Error(`${imageRef} is missing ${missing.join(', ')}, so the bridge cannot run in it`);

  const bashVersion = inside(on, '/bin/bash --version | head -1');
  const tcp = inside(on, `/bin/bash --noprofile --norc -c 'exec 3<>/dev/tcp/127.0.0.1/${CLOSED_PORT}' 2>&1 || true`);
  if (!/connect|refused/i.test(tcp) || /No such file/i.test(tcp)) {
    throw new Error(`${imageRef} has a bash without /dev/tcp, which the bridge is built on: ${tcp}`);
  }

  const evidence = { imageRef, imageId, engineVersion, platform: { os, architecture, variant: variant ?? '' }, binaries, bashVersion, tcp };
  const record = {
    id: on.id ?? `bee-${imageRef.split(':').pop()}-docker-${engineVersion}`,
    imageId,
    engineVersion,
    platform: { os, architecture, variant: variant ?? '' },
    bridgeRevision: 'DOCKER_BEE_BRIDGE_REVISION',
    harnessRevision: gitBlobId(readFileSync(fileURLToPath(import.meta.url))),
    evidenceDigest: `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`,
    bridgeLifetimeSeconds: { min: 1, max: 270 },
    cleanupGraceMs: { min: 1, max: 10_000 },
    streamBounds: 'DOCKER_BEE_STREAM_BOUNDS',
  };

  console.log('# evidence');
  console.log(JSON.stringify(evidence, null, 2));
  console.log('# record, with the two named constants left for the catalogue to fill in');
  console.log(JSON.stringify(record, null, 2));
}

main();

/**
 * The git object id of a file's bytes, which is what `git hash-object` prints.
 *
 * The catalogue records the harness this way so a reader can check the script
 * that produced a record against the repository with one command, and so the
 * value is plainly a file identity rather than anything secret shaped.
 */
function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
