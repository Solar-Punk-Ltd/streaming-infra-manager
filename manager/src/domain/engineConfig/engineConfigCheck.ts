import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ENGINE_DISPLAY_NAMES,
  type EngineName,
  OME_SERVICE,
  unknownPlaceholders,
} from '@streaming-infra-manager/common';

import { omeXmlProblem } from './omeXml.js';
import { substituteForCheck } from './placeholders.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one command to completion, or answers a non zero code when it will not finish. */
export type CommandRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

/**
 * Long enough for the image to be pulled on a host that has never run this
 * engine, which is the first deployment on a new version. The parse itself
 * takes well under a second.
 */
const CHECK_TIMEOUT_MS = 120_000;

/** What the throwaway container may use. It parses one file and exits. */
const CONTAINER_LIMITS = ['--network', 'none', '--memory', '256m', '--pids-limit', '64'];

const SRS_CHECK_PATH = '/check/srs.conf';
const SRS_DEFAULT_IMAGE = 'ossrs/srs:6';
const CHECK_FILE_NAME = 'srs.conf.check';

/** SRS's own log prefix: `[time][level][pid][id] `. */
const SRS_LOG_PREFIX_RE = /^\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\s*/;

const OUTPUT_TAIL_LINES = 6;

export interface ConfigCheckInput {
  engine: EngineName;
  config: string;
  /** The engine's image from the version's compose file, or null when unknown. */
  image: string | null;
  /** The tokens the version's entrypoint fills. Anything else in the file is refused. */
  filled: readonly string[];
  /** A host visible directory the scratch copy for the check goes in. */
  scratchDir: string;
}

export const execFileRunner: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? -1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Whether the engine would read this file, asked of the engine itself where
 * it can be.
 *
 * SRS has a test mode, `srs -t`, that parses a file and names the line it
 * refuses, and it is run in a throwaway container of the deployment's own
 * image so the parser is the one the deployment runs. The file it sees is a
 * copy with every placeholder filled by a dummy, because a token where a
 * number belongs is a parse error of the check's own making. OvenMediaEngine
 * has no test mode, so it gets the XML check and the watch after recreate.
 */
export class EngineConfigChecker {
  constructor(private readonly run: CommandRunner = execFileRunner) {}

  /** Why the file would be refused, in words for the editor, or null. */
  async problem(input: ConfigCheckInput): Promise<string | null> {
    const unknown = unknownPlaceholders(input.config, input.filled);
    if (unknown.length > 0) {
      return (
        `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a placeholder' : 'are not placeholders'} this stack version fills, ` +
        `so the engine would read ${unknown.length === 1 ? 'it' : 'them'} as written. It fills: ${input.filled.join(', ')}.`
      );
    }

    if (input.engine === OME_SERVICE) {
      return omeXmlProblem(substituteForCheck(input.config));
    }
    return this.srsProblem(input);
  }

  private async srsProblem(input: ConfigCheckInput): Promise<string | null> {
    await mkdir(input.scratchDir, { recursive: true });
    const file = join(input.scratchDir, CHECK_FILE_NAME);
    await writeFile(file, substituteForCheck(input.config), 'utf8');
    try {
      const result = await this.run(
        'docker',
        [
          'run',
          '--rm',
          ...CONTAINER_LIMITS,
          '-v',
          `${file}:${SRS_CHECK_PATH}:ro`,
          input.image ?? SRS_DEFAULT_IMAGE,
          './objs/srs',
          '-t',
          '-c',
          SRS_CHECK_PATH,
        ],
        CHECK_TIMEOUT_MS,
      );
      if (result.code === 0) return null;
      return `${ENGINE_DISPLAY_NAMES[input.engine]} refused the file. ${srsReason(result)}`;
    } finally {
      await rm(file, { force: true });
    }
  }
}

/**
 * The line SRS gave as its reason, without its log prefix and with the
 * check's own path replaced by what the operator is looking at. Failing that,
 * the last lines it printed.
 */
function srsReason(result: CommandResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.replace(SRS_LOG_PREFIX_RE, '').trim())
    .filter((line) => line.length > 0);
  const reasons = lines.filter((line) => /invalid config|parse|illegal/i.test(line));
  const picked = reasons.length > 0 ? reasons : lines.slice(-OUTPUT_TAIL_LINES);
  const text = picked.join(' ').split(SRS_CHECK_PATH).join('your config');
  return text || `srs -t exited with code ${result.code} and printed nothing.`;
}
