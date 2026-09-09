import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COMMIT_FILE = '.stack-commit';
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
/** A pin is a whole commit, because the build script fetches it from GitHub by name. */
const PIN_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Which commit a checkout is on, or null when it cannot be asked.
 *
 * This is the answer for every version an operator added: the build script
 * clones and fetches, so the checkout has a `.git` and git is the one thing
 * that knows what the fetch landed on.
 */
export function readCheckoutCommit(root: string): string | null {
  if (!existsSync(join(root, '.git'))) return null;

  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
    return COMMIT_SHA_RE.test(sha) ? sha : null;
  } catch {
    // A checkout git refuses to read is one the manager cannot name a commit
    // for, which is exactly what null means here.
    return null;
  }
}

/**
 * Which commit the bundled checkout is on, or null when the host cannot tell.
 *
 * Two hosts, two answers. On a laptop the submodule has a `.git`, so git can be
 * asked. On the deploy host the tree arrives over rsync with `.git` excluded,
 * so there is nothing to ask: `deploy/deploy.sh` writes the commit into
 * `manager/.stack-commit` next to the checkout before the rsync, and that file
 * is the answer there. Null is a real outcome, for a checkout that arrived by
 * neither route, and the Versions page says so rather than inventing a commit.
 */
export function readBundledCommit(bundledRoot: string): string | null {
  return fromCommitFile(bundledRoot) ?? readCheckoutCommit(bundledRoot);
}

function fromCommitFile(bundledRoot: string): string | null {
  const path = join(dirname(bundledRoot), COMMIT_FILE);
  if (!existsSync(path)) return null;

  const sha = readFileSync(path, 'utf8').trim().toLowerCase();
  return COMMIT_SHA_RE.test(sha) ? sha : null;
}

/**
 * The stack commit this manager ships with, or null when it ships none.
 *
 * `deploy/deploy.sh` writes it beside the checkout, from the submodule pin the
 * repository records rather than from anybody's working tree, and that is what
 * the host builds the bundled version from. A developer machine has no such
 * file, and null is how that says so: there the bundled version stays on the
 * tree in the checkout.
 */
export function readBundledPin(bundledRoot: string): string | null {
  const sha = fromCommitFile(bundledRoot);
  return sha !== null && PIN_SHA_RE.test(sha) ? sha : null;
}

/**
 * Why the file beside a checkout names no commit to build, or null when it
 * names one or when there is no file at all.
 *
 * A machine with no file is a developer laptop, which is not a problem. A file
 * that is there and holds something else is a deploy that went wrong, and this
 * is the only thing that tells the two apart. What it holds is never repeated
 * back, because a broken file can hold anything.
 */
export function bundledPinProblem(bundledRoot: string): string | null {
  if (!existsSync(join(dirname(bundledRoot), COMMIT_FILE))) return null;
  if (readBundledPin(bundledRoot)) return null;
  return `${COMMIT_FILE} beside ${bundledRoot} does not hold a whole commit, so there is nothing to build the bundled version from. Deploy the manager again.`;
}
