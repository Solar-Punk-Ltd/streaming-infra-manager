/**
 * Where the browser is allowed to open a connection, checked by reading the
 * source.
 *
 * Every call belongs to the manager and goes to this page's own origin, which
 * is what lets the funded Bee nodes refuse cross-origin readers outright. A
 * call written anywhere else is how a Bee API port or an engine port would end
 * up addressed from a browser, and nothing but this notices.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CALL_SITES = ['fetch(', 'new EventSource(', 'new WebSocket('];
const OWNERS = new Set(['http.ts', 'liveStream.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

function scanned(): string[] {
  return sourceFiles(SOURCE_ROOT).map((file) => path.relative(SOURCE_ROOT, file));
}

describe('where the browser may open a connection', () => {
  it('is the two modules that own one, and nowhere else', () => {
    const elsewhere = scanned()
      .filter((file) => !OWNERS.has(file))
      .flatMap((file) => {
        const source = readFileSync(path.join(SOURCE_ROOT, file), 'utf8');
        return CALL_SITES.filter((site) => source.includes(site)).map(
          (site) => `${file} writes ${site}`,
        );
      });

    assert.deepEqual(elsewhere, []);
  });

  it('read the source it means to, so finding nothing means something', () => {
    const files = scanned();

    assert.ok(files.length > 100, `only ${files.length} source files found under ${SOURCE_ROOT}`);
    for (const owner of OWNERS) assert.ok(files.includes(owner), `${owner} was not scanned`);
    assert.deepEqual(files.filter((file) => /\.test\.tsx?$/.test(file)), []);
    assert.ok(
      readFileSync(path.join(SOURCE_ROOT, 'http.ts'), 'utf8').includes('fetch('),
      'the owner of every request no longer writes one, so the scan is looking for the wrong thing',
    );
  });
});
