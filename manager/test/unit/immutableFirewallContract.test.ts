import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import { ImmutableFirewallContractReader } from '../../src/domain/ports/ImmutableFirewallContractReader.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'firewall-build-reader-'));
  roots.push(root);
  const buildId = 'a'.repeat(40);
  const dir = buildDirFor(root, 'v3', buildId);
  cpSync(fileURLToPath(new URL('../fixtures/stack/v3/', import.meta.url)), dir, { recursive: true });
  const manifest = { commit: buildId, buildId, builtAt: '2026-09-08T00:00:00.000Z', toolchain: 'fixture-only' };
  writeFileSync(join(dir, '.stack-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, '.complete'), '');
  const version = { id: 1, name: 'v3', layout: 'builds' as const, rootPath: join(root, 'v3'), buildId, previousBuildId: null };
  return { dir, manifest, version, buildId, reader: new ImmutableFirewallContractReader() };
}

describe('immutable firewall contract reader', () => {
  it('reads a finished requested build with actual Compose owners and OME aliases', async () => {
    const h = setup();
    const contract = await h.reader.read(h.version, h.buildId);
    assert.ok(contract.ports.some(port => port.name === 'BEE_RUNG_480P_P2P_PORT'));
    assert.equal(contract.portAliases?.find(port => port.name === 'OME_SRT_PORT')?.service, 'ome');
    assert.deepEqual(Object.keys(contract).sort(), ['allocationProblem', 'maxSlot', 'portAliases', 'ports']);
  });
  for (const broken of ['unfinished', 'wrong-build', 'missing', 'legacy', 'path'] as const) {
    it(`refuses ${broken} build evidence`, async () => {
      const h = setup();
      if (broken === 'unfinished') rmSync(join(h.dir, '.complete'));
      if (broken === 'wrong-build') writeFileSync(join(h.dir, '.stack-manifest.json'), JSON.stringify({ ...h.manifest, buildId: 'b'.repeat(40) }));
      if (broken === 'missing') rmSync(h.dir, { recursive: true });
      await assert.rejects(h.reader.read(broken === 'legacy' ? { ...h.version, layout: 'legacy' } : h.version,
        broken === 'path' ? '../outside' : h.buildId), /firewall|build|manifest|immutable|complete/i);
    });
  }
});
