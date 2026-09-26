import { createHash } from 'node:crypto';
import { BEE_BRIDGE_BINARIES, type BeeBridgeBinaryCheck, type BeeBridgeCheck } from '@streaming-infra-manager/common';
import type { BeeBridgeTuple } from './beeBridgeQualification.js';

/** Starts every line the check prints, so no other output can be taken for an answer. */
export const BEE_BRIDGE_CHECK_MARK = 'bee-bridge-check';
/** Nothing listens here, so a bash that has /dev/tcp is refused rather than told the file does not exist. */
const CLOSED_PORT = 9;
const BINARY_ORDER = Object.keys(BEE_BRIDGE_BINARIES) as BeeBridgeBinaryCheck[];

/**
 * Reads and never writes. The shell classifies bash's answer itself and prints
 * fixed words only, so the manager never has to read upstream text, and it
 * sends everything to stdout, because one exec's framed stdout is what the
 * manager reads.
 */
const CHECK_SCRIPT = `exec 2>&1
for path in ${Object.values(BEE_BRIDGE_BINARIES).join(' ')}; do
  if [ -x "$path" ]; then echo "${BEE_BRIDGE_CHECK_MARK} binary $path present"; else echo "${BEE_BRIDGE_CHECK_MARK} binary $path missing"; fi
done
if [ -x ${BEE_BRIDGE_BINARIES.bash} ]; then
  answer=$(${BEE_BRIDGE_BINARIES.bash} --noprofile --norc -c 'exec 3<>/dev/tcp/127.0.0.1/${CLOSED_PORT}' 2>&1)
  case "$answer" in
    *"No such file"*) echo "${BEE_BRIDGE_CHECK_MARK} dev_tcp missing" ;;
    *refused*) echo "${BEE_BRIDGE_CHECK_MARK} dev_tcp refused" ;;
    *) echo "${BEE_BRIDGE_CHECK_MARK} dev_tcp unexpected" ;;
  esac
fi
echo "${BEE_BRIDGE_CHECK_MARK} done"
`;

/** The one exec the manager runs in a Bee container to check that the bridge can run there. */
export function beeBridgeCheckCommand(): readonly string[] {
  return ['/bin/sh', '-c', CHECK_SCRIPT];
}

/** Which check a stored pass was made by. A change to any byte of the check makes every earlier pass stop counting. */
export const BEE_BRIDGE_CHECK_REVISION = `sha256:${createHash('sha256').update(JSON.stringify(beeBridgeCheckCommand())).digest('hex')}`;

export type DevTcpAnswer = 'refused' | 'missing' | 'unexpected' | 'not_run';
export interface BeeBridgeCheckVerdict {
  readonly binaries: Readonly<Record<BeeBridgeBinaryCheck, boolean>>;
  readonly devTcp: DevTcpAnswer;
  /** The first check that failed, in the order the bridge needs them, or null for a pass. */
  readonly failed: BeeBridgeCheck | null;
}

const UNREADABLE: BeeBridgeCheckVerdict = Object.freeze({
  binaries: Object.freeze({ env: false, timeout: false, bash: false, cat: false }), devTcp: 'not_run', failed: 'answer',
});

/** What the check's answer says. Any line out of place, missing or unknown makes the whole answer unreadable. */
export function beeBridgeCheckVerdict(output: string): BeeBridgeCheckVerdict {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const binaries = {} as Record<BeeBridgeBinaryCheck, boolean>;
  for (const [index, check] of BINARY_ORDER.entries()) {
    const found = new RegExp(`^${BEE_BRIDGE_CHECK_MARK} binary ${BEE_BRIDGE_BINARIES[check]} (present|missing)$`).exec(lines[index] ?? '');
    if (!found) return UNREADABLE;
    binaries[check] = found[1] === 'present';
  }
  let next = BINARY_ORDER.length;
  let devTcp: DevTcpAnswer = 'not_run';
  if (binaries.bash) {
    const found = new RegExp(`^${BEE_BRIDGE_CHECK_MARK} dev_tcp (refused|missing|unexpected)$`).exec(lines[next] ?? '');
    if (!found) return UNREADABLE;
    devTcp = found[1] as DevTcpAnswer;
    next++;
  }
  if (lines[next] !== `${BEE_BRIDGE_CHECK_MARK} done` || lines.length !== next + 1) return UNREADABLE;
  const failed = BINARY_ORDER.find(check => !binaries[check]) ?? (devTcp === 'refused' ? null : 'dev_tcp');
  return Object.freeze({ binaries: Object.freeze(binaries), devTcp, failed });
}

/** What a check found, as it is stored: the tuple and the findings, never the container's own words. */
export interface BeeBridgeCheckEvidence {
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

export function beeBridgeCheckEvidence(tuple: BeeBridgeTuple, verdict: BeeBridgeCheckVerdict): BeeBridgeCheckEvidence {
  const found = (check: BeeBridgeBinaryCheck) => verdict.failed === 'answer' ? 'unknown' : verdict.binaries[check] ? 'present' : 'missing';
  const evidence = Object.freeze({
    imageId: tuple.imageId, engineVersion: tuple.engineVersion,
    platform: { os: tuple.platform.os, architecture: tuple.platform.architecture, variant: tuple.platform.variant },
    bridgeRevision: tuple.bridgeRevision, harnessRevision: BEE_BRIDGE_CHECK_REVISION,
    binaries: Object.fromEntries(BINARY_ORDER.map(check => [BEE_BRIDGE_BINARIES[check], found(check)])),
    devTcp: verdict.devTcp,
  });
  return Object.freeze({ evidence, digest: `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}` });
}
