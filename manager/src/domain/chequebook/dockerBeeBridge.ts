import { createHash } from 'node:crypto';

/** Every binary and shell feature here requires qualification against the immutable Bee image. */
const BRIDGE_SCRIPT = `set -eu
exec 4<&0
exec 3<>/dev/tcp/127.0.0.1/"$1"
/usr/bin/cat <&4 >&3 &
input=$!
/usr/bin/cat <&3 >&1 &
output=$!
cleanup() {
  trap - EXIT
  kill "$input" "$output" 2>/dev/null || true
  wait "$input" "$output" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
wait -n "$input" "$output"
`;

export function dockerBeeBridgeCommand(internalPort: number, lifetimeMs: number, cleanupGraceMs: number): readonly string[] {
  return ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM',
    `--kill-after=${cleanupGraceMs / 1000}s`, `${Math.ceil(lifetimeMs / 1000)}s`, '/bin/bash', '--noprofile', '--norc', '-c',
    BRIDGE_SCRIPT, 'bee-byte-bridge', String(internalPort)];
}

/** A change to any binary, fixed argument or script byte invalidates prior qualification records. */
export const DOCKER_BEE_BRIDGE_REVISION = `sha256:${createHash('sha256').update(JSON.stringify(dockerBeeBridgeCommand(1, 1000, 1000))).digest('hex')}`;
