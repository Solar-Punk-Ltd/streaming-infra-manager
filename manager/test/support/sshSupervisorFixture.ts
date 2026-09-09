import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runNativeSshForwardSupervisor, observeNativeForwardChild } from '../../src/utils/nativeSshForward.js';

const mode = process.argv[2];
if (!['normal', 'ignore-term', 'delay-spawn', 'quiet'].includes(mode)) throw new Error('Invalid synthetic mode');
const report = (value: { fixture: string; pid?: number }) => { if (mode !== 'quiet' && process.connected) process.send?.(value, () => {}); };
runNativeSshForwardSupervisor({ spawn(command) {
  const forward = command.args[command.args.indexOf('-L') + 1]; const path = forward.split(':')[0];
  if (mode === 'delay-spawn') {
    report({ fixture: 'before-spawn' });
    const until = performance.now() + 150; while (performance.now() < until) {}
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./sshForwardChildFixture.mjs', import.meta.url)), path, mode],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false, detached: false });
  const owned = observeNativeForwardChild(child);
  report({ fixture: 'child', pid: child.pid });
  return owned;
} });
