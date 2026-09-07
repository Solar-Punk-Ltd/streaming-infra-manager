/**
 * That the manager's own deploy no longer writes over the tree the engines
 * mount, and ships the bundled stack where the api publishes it from.
 *
 * Read from the file, the way the build script is read: the deploy needs a
 * host, a network and a signing key. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUNDLED_INCOMING_DIR } from '../../src/domain/versions/stackPaths.js';
import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');

const script = readFileSync(DEPLOY_SCRIPT, 'utf8');

/** Every `rsync ...` invocation, each up to its destination line. */
function rsyncs(): string[] {
  return script.split(/\n(?=rsync )/).filter((block) => block.startsWith('rsync ')).map((block) => block.split('\n\n')[0] ?? block);
}

describe('deploy/deploy.sh', () => {
  it('is a script bash accepts', () => {
    execFileSync('bash', ['-n', DEPLOY_SCRIPT]);
  });

  it('leaves the bundled tree the engines mount out of the rsync that deletes into the repo', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${REMOTE_PATH}/"'));
    assert.ok(repo, 'the rsync into the repository');
    assert.match(repo, /--delete/);
    assert.match(repo, /--exclude 'manager\/swarm-hls-stream\/'/);
  });

  it('ships the built stack into the incoming directory under the versions root, without the runtime files', () => {
    const stack = rsyncs().find((block) => block.includes(`${BUNDLED_INCOMING_DIR}`) && block.includes('manager/swarm-hls-stream/'));
    assert.ok(stack, 'the rsync of the stack into the incoming directory');
    assert.match(stack, /--delete/);
    assert.match(stack, /--exclude '\.git\/'/);
    assert.match(stack, /--exclude 'node_modules\/'/);
    assert.match(stack, /--exclude 'deploy\/data\/'/);
    assert.ok(stack.indexOf("--include '.env.sample'") < stack.indexOf("--exclude '.env.*'"), 'the sample is kept, the per deployment envs are not');
    assert.match(stack, /\$\{REMOTE_VERSIONS_ROOT\}\/bundled\.incoming\//, 'under the versions root the host side exports');
  });

  it('writes the commit into the shipment, where the api reads it', () => {
    assert.match(script, new RegExp(`${BUNDLED_INCOMING_DIR}[^\\n]*${STACK_COMMIT_FILE.replace('.', '\\.')}`));
  });

  it('names one versions root on both sides', () => {
    const named = script.match(/streaming-infra-manager-versions/g) ?? [];
    assert.ok(named.length >= 2, 'the laptop side and the host side both name it');
  });
});
