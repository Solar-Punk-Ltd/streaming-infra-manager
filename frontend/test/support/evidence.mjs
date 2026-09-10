import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A directory of this run's own for the screenshots and process notes a
 * browser suite leaves behind.
 *
 * Under RUNNER_TEMP where there is one, which is what the browser job cleans
 * up, and the OS temp directory otherwise. Made fresh every time rather than
 * named: a fixed path is a path an unprivileged runner may not be allowed to
 * create, and a path someone else's run can leave a symlink at.
 */
export function evidenceDirectory(prefix, parent) {
  return mkdtemp(join(parent ?? process.env.RUNNER_TEMP ?? tmpdir(), prefix));
}
