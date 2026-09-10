/**
 * T01: a config file the manager's own check accepts and the engine dies on.
 *
 * The check asks SRS whether it would read the file. That is a parse, and a
 * parse cannot tell whether the engine will still be up in twenty seconds. So
 * a rollout stores the file, recreates the engine on it, watches, and puts the
 * previous file back when the engine does not stay up. This is the file that
 * separates the two, and this test is the only place the whole path runs
 * against real containers.
 *
 * The file is the version's own template with one line added:
 *
 *     work_dir /no/such/directory;
 *
 * Two observations on ossrs/srs@sha256:2be08a0fe28737bf28bae8a575bb5776e09b620366dd1e62dd4f8a41cf4310f3,
 * which is the tag the stack runs, taken on this laptop on 2026-09-10 with the
 * template substituted the way the check substitutes it:
 *
 *   1. The parse the manager runs, `./objs/srs -t -c /check/srs.conf` in a
 *      throwaway container with --network none, exited 0 and printed
 *      "config file /check/srs.conf test is successful". So the check accepts
 *      this file, which is the whole point: a file the check refuses would
 *      never reach a rollout.
 *   2. The start the stack's entrypoint runs, `./objs/srs -c conf/srs.conf`,
 *      left the container exited with code 255 one second in, printing
 *      "Failed, code=-1 : chdir to /no/such/directory, r0=-1" and
 *      "do_main() [./src/main/srs_main_server.cpp:150][errno=2](No such file
 *      or directory)". SRS reads its config, then changes directory, and only
 *      the second step touches the file system.
 *
 * Both were taken again the same day, on this digest, after the first pin
 * turned out to name an image no tag points at any more. Same two answers:
 * the parse exited 0 and the start exited 255 on the chdir line.
 *
 * This file has never run. It needs the whole stack deployed on a runner, so
 * its first run is Levi's dispatch of the docker-backed workflow. See
 * docs/ci.md.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type EngineConfigState,
  type EngineConfigView,
  rolloutNotice,
} from '@streaming-infra-manager/common';

import { redactEngineOutput } from '../support/redactEngineOutput.js';
import { assertMatchesRedacted, assertNull } from '../support/redactedAssertions.js';
import {
  BEE_UPLOADER,
  SRS,
  api,
  cleanup,
  createProfile,
  getProfileOrNull,
  removeProfile,
  requireStack,
  uniqueName,
  waitForGone,
  waitForRunningServices,
} from './helpers.js';

const DEPLOY_TIMEOUT = 240_000;

/** The watch is twenty seconds, and the revert redeploys after it. */
const ROLLOUT_TIMEOUT = 300_000;
const ROLLOUT_POLL_MS = 3_000;

/** A rollout that is still moving. Anything else is where it ended. */
const IN_FLIGHT: readonly EngineConfigState[] = ['applying', 'watching', 'reverting'];

/** SRS reads its config before it changes directory, so this passes the parse and kills the start. */
const POISONED_DIRECTIVE = 'work_dir /no/such/directory;';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const engineConfig = (name: string) =>
  api<EngineConfigView>('GET', `/profiles/${encodeURIComponent(name)}/engine-config`);

async function waitForRolloutEnd(name: string): Promise<EngineConfigView> {
  const deadline = Date.now() + ROLLOUT_TIMEOUT;
  let last: EngineConfigView | null = null;
  while (Date.now() < deadline) {
    last = await engineConfig(name);
    if (last.state !== null && !IN_FLIGHT.includes(last.state)) return last;
    await sleep(ROLLOUT_POLL_MS);
  }
  throw new Error(
    `timed out after ${ROLLOUT_TIMEOUT}ms awaiting the end of the rollout on ${name}; last state=${last?.state ?? 'absent'}`,
  );
}

before(requireStack);
after(async () => {
  await cleanup();
});

describe('a config file the check accepts and the engine dies on', () => {
  it('reverts to the previous file and leaves the deployment running on it', async () => {
    const name = uniqueName('startup');
    await createProfile({ name, kind: 'streamer', notes: 'engine startup failure' });
    await waitForRunningServices(name, [BEE_UPLOADER, SRS], { timeoutMs: DEPLOY_TIMEOUT });

    const onTemplate = await engineConfig(name);
    assert.equal(onTemplate.engine, SRS, 'a streamer runs SRS, which is the engine with a parser to ask');
    assert.ok(onTemplate.supported, onTemplate.unsupportedReason ?? 'this version does not run a file of its own');
    assertNull(onTemplate.config, 'a fresh deployment runs the template, which is the file the revert has to bring back');

    // Accepted by the check, because the parse never changes directory.
    await api('PUT', `/profiles/${encodeURIComponent(name)}/engine-config`, {
      config: `${onTemplate.template}\n${POISONED_DIRECTIVE}\n`,
    });

    const ended = await waitForRolloutEnd(name);
    // The reason embeds the engine's own last lines, and the file SRS was
    // started on carries this deployment's SRT passphrase and webhook token.
    // Nothing below compares either of them directly: a failing assertion
    // publishes its own actual value, and this file's failures are read in an
    // Actions log. The tail is matched on its redacted copy and the stored file
    // on whether it is gone, both from test/support/redactedAssertions.
    const reason = ended.error ? redactEngineOutput(ended.error) : '(no reason)';
    assert.equal(ended.state, 'reverted', `the rollout ended ${ended.state}, not reverted: ${reason}`);
    assert.ok(ended.error, 'a reverted rollout has to say why');
    assertMatchesRedacted(
      ended.error,
      /so the previous one is back/,
      'the reason does not say the previous file is back',
    );
    assertMatchesRedacted(
      ended.error,
      /no\/such\/directory/,
      "the reason does not carry the engine's own last lines",
    );
    assertNull(ended.config, 'the template is back, so the stored file is gone');

    const notice = rolloutNotice(ended.state, { engine: ended.engine, hasConfig: ended.config !== null }, ended.error);
    assert.ok(notice, 'a reverted rollout shows a notice');
    assert.equal(notice.severity, 'warning');
    assert.equal(notice.showsReason, true, 'the reason is the rest of the story and the card shows it');
    assert.deepEqual(notice.offers, [], 'a finished revert leaves the operator nothing to press');

    const running = await waitForRunningServices(name, [BEE_UPLOADER, SRS], { timeoutMs: DEPLOY_TIMEOUT });
    assert.equal(running.status, 'RUNNING', 'the deployment is up again on the previous file');

    await removeProfile(name);
    await waitForGone(name);
    assertNull(await getProfileOrNull(name), 'the profile is gone, and a profile carries the passphrase too');
  });
});
