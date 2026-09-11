/**
 * That a test file's throwaway directory goes when the file does.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The removal runs on the process's own `exit`, so it cannot be watched from
 * inside the process that registered it. Each case below is a child that makes
 * a directory and ends, and what this file looks at is what the child left.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { throwawayRoot } from '../support/throwawayRoot.js';

const helper = fileURLToPath(new URL('../support/throwawayRoot.ts', import.meta.url));

/** A child that makes a root, says where it is, and then ends the way the argument asks. */
function childLeaving(ending: string): string {
  const source = `
    const { throwawayRoot } = await import(${JSON.stringify(helper)});
    const root = throwawayRoot('throwaway-root-case-');
    console.log(root);
    ${ending}
  `;
  // The child loads a TypeScript file, so it needs the same loader this run has.
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { encoding: 'utf8' });
  const root = child.stdout.split('\n')[0]!.trim();
  assert.match(root, /throwaway-root-case-/, `the child said where its root was, saw ${JSON.stringify(child.stdout + child.stderr)}`);
  return root;
}

it('is removed when the file that made it ends', () => {
  assert.equal(existsSync(childLeaving('')), false);
});

it('is removed when the file that made it throws', () => {
  assert.equal(existsSync(childLeaving("throw new Error('the suite failed');")), false);
});

it('is removed even though the file wrote into it', () => {
  const ending = `
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(root, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'scripts', 'deploy.sh'), 'exit 0');
  `;
  assert.equal(existsSync(childLeaving(ending)), false);
});

it('makes a directory of its own for every caller', () => {
  const first = throwawayRoot('throwaway-root-pair-');
  const second = throwawayRoot('throwaway-root-pair-');

  assert.notEqual(first, second);
  assert.equal(existsSync(first) && existsSync(second), true, 'both are there while this process is');
});
