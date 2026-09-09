import { execFile } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Whether the command outlived its timeout and was killed rather than exiting on its own. */
  killed: boolean;
  signal: NodeJS.Signals | null;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Runs one command to completion and answers what it printed.
 *
 * The command is an argument list, never a string a shell would take apart,
 * so a path or a value with a space in it cannot become two arguments or a
 * second command. A command that outlives its timeout is killed and answers a
 * non zero code rather than holding the upgrade open.
 */
export type CommandRunner = (argv: readonly string[], options: CommandOptions) => Promise<CommandResult>;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface ExecFileFailure extends Error {
  code?: unknown;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

export const execFileCommandRunner: CommandRunner = (argv, options) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (!file) throw new Error('A command needs a program to run.');
    execFile(
      file,
      args,
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const failure = error as ExecFileFailure | null;
        const status = failure && typeof failure.code === 'number' ? failure.code : failure ? -1 : 0;
        resolve({
          code: status,
          stdout: String(stdout),
          stderr: String(stderr),
          killed: Boolean(failure?.killed),
          signal: failure?.signal ?? null,
        });
      },
    );
  });
