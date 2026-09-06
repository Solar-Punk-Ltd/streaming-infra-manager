import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

const SECRET_ARG_NAME = /^--[a-z0-9-]*(key|secret|passphrase|password|token)/i;

/**
 * Script arguments as a single line, with the value of anything named like a
 * secret replaced.
 *
 * A second control, not the first one: a secret belongs in the profile's env
 * file rather than in an argument, because an argument is visible in the
 * process table to every user on the host for as long as the script runs. This
 * only keeps one that slips back in out of the manager's logs, which are read
 * far more often and kept far longer.
 */
export function describeArgsForLog(args: readonly string[]): string {
  return args
    .map((arg) => {
      const eq = arg.indexOf('=');
      if (eq <= 0) return arg;
      const name = arg.slice(0, eq);
      return SECRET_ARG_NAME.test(name) ? `${name}=<redacted>` : arg;
    })
    .join(' ');
}

export interface RunHandle {
  /**
   * Emits:
   *  - 'stdout' (chunk: string)
   *  - 'stderr' (chunk: string)
   *  - 'error'  (err: Error)
   *  - 'done'   ({ code: number })
   */
  emitter: EventEmitter;
  kill(): void;
}

/** What a caller needs from the runner, so a test can stand in for it. */
export interface ScriptSpawner {
  run(scriptPath: string, args: string[], options?: RunOptions): RunHandle;
}

/**
 * Pure-process wrapper. No HTTP, no DB knowledge — just spawn a bash script,
 * stream output via EventEmitter, and let the caller decide what to do (SSE,
 * collect into a buffer, write to disk, etc.).
 *
 * Always invoked via /bin/bash (never `shell: true`) so caller-supplied args
 * can't be interpreted as shell metacharacters.
 */
export class ScriptRunner implements ScriptSpawner {
  run(scriptPath: string, args: string[], options: RunOptions = {}): RunHandle {
    const emitter = new EventEmitter();
    let child: ChildProcess;

    try {
      child = spawn('bash', [scriptPath, ...args], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Defer the emit so subscribers attached after .run() returns still see it.
      setImmediate(() => emitter.emit('error', err));
      return { emitter, kill: () => undefined };
    }

    logger.info(
      `[ScriptRunner] spawn ${scriptPath} ${describeArgsForLog(args)}`,
    );

    child.stdout?.on('data', (b: Buffer) => emitter.emit('stdout', b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => emitter.emit('stderr', b.toString('utf8')));
    child.on('error', (err) => emitter.emit('error', err));
    child.on('close', (code) => emitter.emit('done', { code: code ?? -1 }));

    return {
      emitter,
      kill: () => {
        if (!child.killed) child.kill('SIGTERM');
      },
    };
  }
}
