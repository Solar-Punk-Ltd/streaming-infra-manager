import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const supervisor = fork(fileURLToPath(new URL('./sshSupervisorFixture.ts', import.meta.url)), [process.argv[2]], {
  execArgv: ['--import', import.meta.resolve('tsx'), '--conditions=development'],
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
});
supervisor.stderr!.resume();
supervisor.on('error', () => { process.exitCode = 1; });
supervisor.on('message', value => { if (process.connected) process.send?.(value); });
supervisor.on('close', () => { if (process.connected) process.disconnect(); });
process.on('message', value => { if (supervisor.connected) supervisor.send(value); });
process.send?.({ fixture: 'supervisor', pid: supervisor.pid });
