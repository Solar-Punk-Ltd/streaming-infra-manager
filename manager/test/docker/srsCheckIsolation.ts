/**
 * T02: the real SRS parser, asked eight questions at once, on eight files that
 * differ in one directive each.
 *
 * The manager's config check writes a copy of the file into a directory of its
 * own and mounts that copy into a throwaway container of the deployment's own
 * image. Eight checks in flight is where a shared scratch file would show:
 * one check would read another's copy and refuse with a directive that is not
 * in the file the operator is looking at, which reads as a real refusal. So
 * every refusal here has to name the directive of its own file and none of the
 * others, and no directive of any of the other seven files at all, and the
 * scratch directory has to be empty when the eight are done.
 *
 * The isolation evidence is in the four refusals. An accepted file's only
 * observable is that nothing was said about it, so the four accepted cases
 * prove that a valid file is not refused and nothing more: two of them
 * swapped for each other would look exactly the same from here.
 *
 * Run it through manager/test/docker/srs-check-isolation.sh, which is where
 * the image pin and the evidence live.
 */
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SRS_SERVICE } from '@streaming-infra-manager/common';

import { EngineConfigChecker, execFileRunner } from '../../src/domain/engineConfig/engineConfigCheck.js';
import { engineTemplateIn } from '../../src/domain/engineConfig/engineConfigTemplates.js';

export interface CheckCase {
  /** How the case is named in the output, and the key its answer comes back under. */
  name: string;
  /**
   * The directive the case is about. An accepted case changes its value, a
   * refused case breaks it, and a refusal has to name it and no other case's.
   */
  directive: string;
  /** The template line the case rewrites. A template without it is a harness problem. */
  anchor: string;
  replacement: string;
  accepted: boolean;
}

export const ACCEPTED_CASES: CheckCase[] = [
  {
    name: 'max_connections lowered',
    directive: 'max_connections',
    anchor: 'max_connections     1000;',
    replacement: 'max_connections     500;',
    accepted: true,
  },
  {
    name: 'pbkeylen raised',
    directive: 'pbkeylen',
    anchor: '    pbkeylen        16;',
    replacement: '    pbkeylen        32;',
    accepted: true,
  },
  {
    name: 'tlpktdrop turned off',
    directive: 'tlpktdrop',
    anchor: '    tlpktdrop       on;',
    replacement: '    tlpktdrop       off;',
    accepted: true,
  },
  {
    name: 'tsbpdmode turned off',
    directive: 'tsbpdmode',
    anchor: '    tsbpdmode       on;',
    replacement: '    tsbpdmode       off;',
    accepted: true,
  },
];

export const REFUSED_CASES: CheckCase[] = [
  {
    name: 'listen emptied',
    directive: 'listen',
    anchor: 'listen              RTMP_PORT_PLACEHOLDER;',
    replacement: 'listen;',
    accepted: false,
  },
  {
    name: 'max_connections without its semicolon',
    directive: 'max_connections',
    anchor: 'max_connections     1000;',
    replacement: 'max_connections     1000',
    accepted: false,
  },
  {
    name: 'pbkeylen without its semicolon',
    directive: 'pbkeylen',
    anchor: '    pbkeylen        16;',
    replacement: '    pbkeylen        16',
    accepted: false,
  },
  {
    name: 'http_server left unclosed',
    directive: 'http_server',
    anchor: 'http_server {',
    replacement: 'http_server',
    accepted: false,
  },
];

export const CHECK_CASES: CheckCase[] = [...ACCEPTED_CASES, ...REFUSED_CASES];

/** The file this case asks about, or a harness error when the template moved under it. */
export function applyCase(template: string, one: CheckCase): string {
  if (!template.includes(one.anchor)) {
    throw new Error(`The template has no anchor ${JSON.stringify(one.anchor)}, so the case ${one.name} cannot be built.`);
  }
  return template.replace(one.anchor, one.replacement);
}

export interface CaseAnswer {
  name: string;
  /** What the checker said, or null when it accepted the file. */
  problem: string | null;
}

/** Every wrong answer in the eight, in words, and an empty list when all eight were right. */
export function wrongAnswers(answers: readonly CaseAnswer[]): string[] {
  const wrong: string[] = [];
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  for (const answer of answers) {
    if (!CHECK_CASES.some((one) => one.name === answer.name)) {
      wrong.push(`${answer.name}: an answer that belongs to no case.`);
    }
  }
  for (const one of CHECK_CASES) {
    const answer = byName.get(one.name);
    if (!answer) {
      wrong.push(`${one.name}: no answer came back.`);
      continue;
    }
    if (one.accepted) {
      if (answer.problem !== null) wrong.push(`${one.name}: a valid file was refused with "${answer.problem}".`);
      continue;
    }
    if (answer.problem === null) {
      wrong.push(`${one.name}: a file with a broken ${one.directive} was accepted.`);
      continue;
    }
    if (!answer.problem.includes(one.directive)) {
      wrong.push(`${one.name}: the refusal does not name ${one.directive}: "${answer.problem}".`);
    }
    // Every other case's directive, accepted ones included: a refusal carrying
    // a directive that only another file changed is the same cross-talk as one
    // carrying a directive another file broke. Two cases share a directive, so
    // this is a set and a refusal is reported once.
    const others = new Set(CHECK_CASES.map((other) => other.directive));
    others.delete(one.directive);
    for (const intruder of [...others].filter((directive) => answer.problem!.includes(directive))) {
      wrong.push(
        `${one.name}: the refusal names ${intruder}, which is only in another case's file. ` +
          `That is one check reading another check's copy: "${answer.problem}".`,
      );
    }
  }
  return wrong;
}

const HARNESS_PROBLEM = 2;
const WRONG_ANSWER = 1;

async function main(): Promise<number> {
  const [stackRoot, image, scratchRoot] = process.argv.slice(2);
  if (!stackRoot || !image) {
    console.error('usage: srsCheckIsolation.ts <stack root> <srs image> [scratch root]');
    return HARNESS_PROBLEM;
  }
  const template = engineTemplateIn(stackRoot, SRS_SERVICE);
  const configs = CHECK_CASES.map((one) => ({ one, config: applyCase(template.text, one) }));

  // Inside the root the shell script owns when there is one, so a signal that
  // never reaches the finally below still leaves nothing behind.
  const scratchDir = await mkdtemp(join(scratchRoot ?? tmpdir(), 't02-srs-check-'));
  const checker = new EngineConfigChecker(execFileRunner);
  try {
    console.log(`Eight checks at once on ${image}, scratch ${scratchDir}`);
    const answers = await Promise.all(
      configs.map(async ({ one, config }) => ({
        name: one.name,
        problem: await checker.problem({
          engine: SRS_SERVICE,
          config,
          image,
          filled: template.placeholders,
          template: template.text,
          scratchDir,
        }),
      })),
    );
    for (const answer of answers) {
      console.log(`  ${answer.problem === null ? 'accepted' : 'refused '} ${answer.name}${answer.problem ? `: ${answer.problem}` : ''}`);
    }

    const wrong = wrongAnswers(answers);
    const left = await readdir(scratchDir);
    if (left.length > 0) {
      wrong.push(`the scratch directory still holds ${left.join(', ')}, so a check did not clear up after itself.`);
    }
    if (wrong.length > 0) {
      for (const line of wrong) console.error(`FAIL: ${line}`);
      return WRONG_ANSWER;
    }
    console.log('PASS: four valid files accepted, four refused each naming only its own directive, scratch directory empty');
    return 0;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

// Imported by the unit test that exercises the judging above, run as a
// program by the shell script beside this file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(`HARNESS: ${error instanceof Error ? error.message : String(error)}`);
    return HARNESS_PROBLEM;
  });
}
