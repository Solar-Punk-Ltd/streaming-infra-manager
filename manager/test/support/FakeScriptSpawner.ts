import { EventEmitter } from 'node:events';

import type {
  RunHandle,
  RunOptions,
  ScriptSpawner,
} from '../../src/domain/ScriptRunner.js';

export interface SpawnedScript {
  script: string;
  args: string[];
  options: RunOptions | undefined;
  emitter: EventEmitter;
  killed: boolean;
}

/**
 * A script runner that spawns nothing and hands the test the handle, so a build
 * can be held open, finished with any exit code, or made to fail to start at
 * all. Nothing here reaches git, docker or the filesystem.
 */
export class FakeScriptSpawner implements ScriptSpawner {
  readonly spawned: SpawnedScript[] = [];

  run(script: string, args: string[], options?: RunOptions): RunHandle {
    const emitter = new EventEmitter();
    const entry: SpawnedScript = {
      script,
      args,
      options,
      emitter,
      killed: false,
    };
    this.spawned.push(entry);
    return {
      emitter,
      kill: () => {
        entry.killed = true;
      },
    };
  }

  get last(): SpawnedScript {
    const entry = this.spawned[this.spawned.length - 1];
    if (!entry) throw new Error('no script has been spawned');
    return entry;
  }

  /** Finishes the newest run, the way a real script ending would. */
  finish(code: number, log = ''): void {
    if (log) this.last.emitter.emit('stdout', log);
    this.last.emitter.emit('done', { code });
  }
}
