/**
 * Every view that judges a deployment passes the readings its page holds.
 *
 * readinessOf takes a stamp reading and a chequebook reading, and a view that
 * hands it neither gets a verdict about nothing. That is what put four funded
 * and stamped pool members under "Needs attention" on 2026-09-17 while each
 * one's own page called it ready. The readings come from a page's own fetches,
 * so nothing but reading the call sites notices when a view forgets them.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERDICTS = '(?:readinessOf|needsAttention)';
const PROFILE_ALONE = new RegExp(`${VERDICTS}\\(\\s*[A-Za-z_$][\\w$.]*\\s*\\)`);
const NO_STAMP_READING = new RegExp(`${VERDICTS}\\([^)]*,\\s*undefined\\s*,`);
const CALLERS = [
  'deployments/DeploymentRow.tsx',
  'deployments/DeploymentsPage.tsx',
  'groups/PoolRungRow.tsx',
  'overview/AttentionList.tsx',
  'overview/OverviewPage.tsx',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const scanned = (): string[] =>
  sourceFiles(SOURCE_ROOT).map((file) => path.relative(SOURCE_ROOT, file));

const offenders = (pattern: RegExp): string[] =>
  scanned().filter((file) =>
    pattern.test(readFileSync(path.join(SOURCE_ROOT, file), 'utf8')),
  );

describe('the readings a view hands to a readiness verdict', () => {
  it('never leaves a deployment judged by its profile alone', () => {
    assert.deepEqual(offenders(PROFILE_ALONE), []);
  });

  it('never says a stamp was not read where the page holds the reading', () => {
    assert.deepEqual(offenders(NO_STAMP_READING), []);
  });

  it('read the source it means to, so finding nothing means something', () => {
    const files = scanned();

    assert.ok(files.length > 100, `only ${files.length} source files found under ${SOURCE_ROOT}`);
    for (const caller of CALLERS) {
      assert.ok(files.includes(caller), `${caller} was not scanned`);
      const source = readFileSync(path.join(SOURCE_ROOT, caller), 'utf8');
      assert.match(source, new RegExp(`${VERDICTS}\\(`), `${caller} asks for no verdict any more`);
    }
  });
});
