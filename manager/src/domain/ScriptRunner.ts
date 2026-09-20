import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { Logger } from './Logger.js';
import { scriptEnv } from './scriptEnv.js';

const logger = Logger.getInstance();

export interface RunOptions {
  /**
   * The directory the script runs in, and for a stack script the root of the
   * checkout being deployed, whose samples say which names belong to the
   * deployment rather than to the manager. See `scriptEnv`.
   */
  cwd?: string;
  /** Set for the script to read, over anything the environment already says. */
  env?: Record<string, string>;
  /** Exact values removed from both output streams before any listener sees them. */
  redactedValues?: readonly string[];
}

const SECRET_ARG_NAME = /^--[a-z0-9-]*(key|secret|passphrase|password|token)/i;

/**
 * Script arguments as a single line, with the value of anything named like a
 * secret replaced.
 *
 * A second control, not the first one: a secret belongs in the consuming
 * process environment rather than in an argument, because an argument is
 * visible in the process table to every user on the host for as long as the
 * script runs. This only keeps one that slips back in out of the manager's
 * logs, which are read far more often and kept far longer.
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

/**
 * How a run ended.
 *
 * A process ended by a signal has no exit code of its own, so the code is -1
 * and the signal is the whole of what happened to it. Nothing else says a run
 * was killed rather than finished.
 */
export interface RunOutcome {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface RunHandle {
  /**
   * Emits:
   *  - 'stdout' (chunk: string)
   *  - 'stderr' (chunk: string)
   *  - 'error'  (err: Error)
   *  - 'done'   (RunOutcome)
   */
  emitter: EventEmitter;
  kill(): void;
}

/** What a caller needs from the runner, so a test can stand in for it. */
export interface ScriptSpawner {
  run(scriptPath: string, args: string[], options?: RunOptions): RunHandle;
}

/**
 * Spawns a bash script and streams its output, leaving the caller to decide
 * what to do with it (SSE, a buffer, a file). No HTTP and no database.
 *
 * It does read the filesystem for one thing: `scriptEnv` opens the checkout at
 * `cwd` and its `engines/*` samples to work out which names belong to the
 * deployment rather than to the manager, so the script is not handed the
 * manager's own environment.
 *
 * Always invoked via /bin/bash (never `shell: true`) so caller-supplied args
 * cannot be interpreted as shell metacharacters.
 */
export class ScriptRunner implements ScriptSpawner {
  run(scriptPath: string, args: string[], options: RunOptions = {}): RunHandle {
    const emitter = new EventEmitter();
    let child: ChildProcess;

    try {
      child = spawn('bash', [scriptPath, ...args], {
        cwd: options.cwd,
        env: scriptEnv(process.env, options.cwd, options.env),
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

    const stdout = new StreamingRedactor(options.redactedValues);
    const stderr = new StreamingRedactor(options.redactedValues);
    child.stdout?.on('data', (b: Buffer) => {
      const text = stdout.push(b.toString('utf8'));
      if (text) emitter.emit('stdout', text);
    });
    child.stderr?.on('data', (b: Buffer) => {
      const text = stderr.push(b.toString('utf8'));
      if (text) emitter.emit('stderr', text);
    });
    child.on('error', (err) => emitter.emit('error', err));
    child.on('close', (code, signal) => {
      const finalStdout = stdout.flush();
      const finalStderr = stderr.flush();
      if (finalStdout) emitter.emit('stdout', finalStdout);
      if (finalStderr) emitter.emit('stderr', finalStderr);
      emitter.emit('done', { code: code ?? -1, signal });
    });

    return {
      emitter,
      kill: () => {
        if (!child.killed) child.kill('SIGTERM');
      },
    };
  }
}

const REDACTED = '<redacted>';

class StreamingRedactor {
  private readonly values: string[];
  private readonly holdCharacters: number;
  private pending = '';

  constructor(values: readonly string[] = []) {
    this.values = [...new Set(values.filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
    this.holdCharacters = Math.max(
      0,
      ...this.values.map((value) => value.length - 1),
    );
  }

  push(chunk: string): string {
    if (this.values.length === 0) return chunk;
    const combined = this.pending + chunk;
    let emitEnd = Math.max(0, combined.length - this.holdCharacters);
    let changed = true;
    while (changed) {
      changed = false;
      for (const value of this.values) {
        let start = combined.indexOf(value);
        while (start >= 0 && start < emitEnd) {
          if (start + value.length > emitEnd) {
            emitEnd = start;
            changed = true;
            break;
          }
          start = combined.indexOf(value, start + 1);
        }
      }
    }
    const ready = combined.slice(0, emitEnd);
    this.pending = combined.slice(emitEnd);
    return this.redact(ready);
  }

  flush(): string {
    const ready = this.redact(this.pending);
    this.pending = '';
    return ready;
  }

  private redact(text: string): string {
    return this.values.reduce(
      (redacted, value) => redacted.replaceAll(value, REDACTED),
      text,
    );
  }
}
