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
    const run = { script, args, options };
    this.runs.push(run);
    this.emitters.push(emitter);
    this.onStart?.(run);
    return { emitter, kill: () => undefined };
  }

  /** Runs as a run is created: the state of the world at the moment of the spawn. */
  onStart?: (run: RecordedScriptRun) => void;

  /** Runs before a finish is reported, with the run: what the script would have left behind. */
  onFinish?: (run: RecordedScriptRun) => void;

  /**
   * What the script printed on its way, which is what a caller keeps as the
   * reason a run failed. The stack's assert-started.sh puts a failed
   * container's last log lines on this stream.
   */
  print(index: number, chunk: string, stream: 'stdout' | 'stderr' = 'stderr'): void {
    this.emitters[index]?.emit(stream, chunk);
  }

  finish(index: number, code = 0, signal: NodeJS.Signals | null = null): void {
    const run = this.runs[index];
    if (run) this.onFinish?.(run);
    this.emitters[index]?.emit('done', { code, signal });
  }

  /** The script never started: what a bad path or a missing bash looks like from the runner. */
  abort(index: number, message: string): void {
    this.emitters[index]?.emit('error', new Error(message));
  }
}
