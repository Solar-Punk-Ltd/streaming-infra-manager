/**
 * That every router really is mounted behind the gate.
 *
 * The routes themselves are tested over HTTP against a small app assembled the
 * same way. This one reads `api/server.ts` instead, because the property that
 * matters is not what any single route does but where the `app.use` lines sit
 * relative to each other: a router added above `requireSession` is open to
 * anyone, and looks exactly like a router added below it. That is how the two
 * Server-Sent Events streams would quietly stay public.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', '..', 'src', 'api', 'server.ts');

/** The routes that answer without a session, and nothing else may join them. */
const OPEN_MOUNTS = ["app.use('/health'", "app.use('/auth'"];

const GATE = 'app.use(requireSession);';

function serverSource(): string {
  return readFileSync(SERVER, 'utf8');
}

/** Every `app.use('/...` mount line, in the order Express will run them. */
function mountLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('app.use('));
}

describe('server.ts mount order', () => {
  it('requires a session before every router but the two open ones', () => {
    const lines = mountLines(serverSource());
    const gate = lines.indexOf(GATE);

    assert.notEqual(gate, -1, `could not find "${GATE}" in server.ts`);

    const before = lines.slice(0, gate).filter((line) => line.includes("'/"));
    assert.deepEqual(
      before.map((line) => line.slice(0, line.indexOf(',') + 1)),
      OPEN_MOUNTS.map((mount) => `${mount},`),
      'only /health and /auth may be mounted above requireSession',
    );

    const after = lines.slice(gate + 1);
    for (const path of ["'/events'", "'/metrics'", "'/profiles'", "'/groups'"]) {
      assert.ok(
        after.some((line) => line.includes(path)),
        `${path} must be mounted below requireSession`,
      );
    }
  });

  it('checks every write for cross-site before anything else looks at it', () => {
    const lines = mountLines(serverSource());

    assert.ok(
      lines.indexOf('app.use(requireSameSite);') <
        lines.findIndex((line) => line.includes("'/")),
      'requireSameSite must run before the first router',
    );
  });
});
