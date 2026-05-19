import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { Logger } from './Logger.js';

const logger = Logger.getInstance();

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
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

/**
 * Pure-process wrapper. No HTTP, no DB knowledge — just spawn a bash script,
 * stream output via EventEmitter, and let the caller decide what to do (SSE,
 * collect into a buffer, write to disk, etc.).
 *
 * Always invoked via /bin/bash (never `shell: true`) so caller-supplied args
 * can't be interpreted as shell metacharacters.
 */
export class ScriptRunner {
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

    logger.info(`[ScriptRunner] spawn ${scriptPath} ${args.join(' ')}`);

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
