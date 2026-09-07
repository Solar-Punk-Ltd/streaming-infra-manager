import { EventEmitter } from 'node:events';

import {
  RunHandle,
  RunOptions,
  ScriptRunner,
} from '../../src/domain/ScriptRunner.js';

export interface RecordedScriptRun {
  script: string;
  args: string[];
  options: RunOptions;
}

/**
 * A ScriptRunner that records what it was asked to run and spawns nothing.
 *
 * A recorded run stays unfinished until `finish` is called, so a test can look
 * at the state a deployment leaves behind while its job is still going.
 */
export class FakeScriptRunner extends ScriptRunner {
  readonly runs: RecordedScriptRun[] = [];

  private readonly emitters: EventEmitter[] = [];

  override run(
    script: string,
    args: string[],
    options: RunOptions = {},
  ): RunHandle {
    const emitter = new EventEmitter();
    this.runs.push({ script, args, options });
    this.emitters.push(emitter);
    return { emitter, kill: () => undefined };
  }

  /** Runs before a finish is reported, with the run: what the script would have left behind. */
  onFinish?: (run: RecordedScriptRun) => void;

  finish(index: number, code = 0): void {
    const run = this.runs[index];
    if (run) this.onFinish?.(run);
    this.emitters[index]?.emit('done', { code });
  }

  /** The script never started: what a bad path or a missing bash looks like from the runner. */
  abort(index: number, message: string): void {
    this.emitters[index]?.emit('error', new Error(message));
  }
}
