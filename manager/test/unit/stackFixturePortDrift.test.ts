/**
 * The v3 contract fixture publishes its ports the way the branch does.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The fixture under test/fixtures/stack/v3 stands in for a checkout of the
 * stack branch in every contract test, and its own header says it carries
 * every port mapping the branch publishes. When that stops being true the
 * reader is proved against a file nobody publishes: the three engine HTTP
 * ports sat here in the two-part form for as long as the branch had already
 * moved them to `bind:published:container`, so only the four Bee lines ever
 * exercised the form the reader has to follow. The comparison is against the
 * submodule at manager/swarm-hls-stream, which is the checkout this manager
 * deploys.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE_COMPOSE = fileURLToPath(
  new URL('../fixtures/stack/v3/deploy/docker-compose.yml', import.meta.url),
);
const BRANCH_COMPOSE = fileURLToPath(
  new URL('../../swarm-hls-stream/deploy/docker-compose.yml', import.meta.url),
);

/** A line a compose file carries under a `ports:` key, and where it sits. */
interface PortLine {
  number: number;
  text: string;
}

function portLines(compose: string): PortLine[] {
  const found: PortLine[] = [];
  let underPorts = false;
  for (const [index, text] of compose.split('\n').entries()) {
    const body = text.trim();
    if (body === 'ports:') {
      underPorts = true;
      continue;
    }
    if (!underPorts) continue;
    if (body.startsWith('- ') || body.startsWith('#')) found.push({ number: index + 1, text });
    else underPorts = false;
  }
  return found;
}

function branchCompose(): string {
  assert.ok(
    existsSync(BRANCH_COMPOSE),
    `The stack submodule is missing at ${BRANCH_COMPOSE}, so the fixture would be compared against nothing. Run git submodule update --init.`,
  );
  return readFileSync(BRANCH_COMPOSE, 'utf8');
}

describe('the v3 contract fixture against the branch it was cut from', () => {
  it('carries every line under a ports: key verbatim from the branch', () => {
    const branch = new Set(branchCompose().split('\n'));
    const fixture = portLines(readFileSync(FIXTURE_COMPOSE, 'utf8'));
    assert.ok(fixture.length > 0, 'the fixture publishes no port at all, so it stands in for nothing');
    assert.deepEqual(
      fixture.filter((line) => !branch.has(line.text)).map((line) => `line ${line.number}: ${line.text.trim()}`),
      [],
      'these fixture lines are no longer in the branch, so the reader is proved against a file nobody publishes',
    );
  });
});
