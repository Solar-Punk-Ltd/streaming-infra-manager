/**
 * Where a chain endpoint could leave the manager inside text it did not write.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Bee prints the value of `--blockchain-rpc-endpoint` into its own log on every
 * start, and prints it again when it cannot reach the chain. Two doors carry
 * that text out of the manager: the container logs route, which a page renders,
 * and a failed deploy's output, which the stack's assert-started.sh fills with
 * the container's last lines and which becomes the deployment's `last_error`,
 * an event on the stream every open page reads, and a line in the manager's own
 * log. An endpoint with a key in its path goes through all four unless it is
 * taken out here.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { ManagerEvent } from '../../src/domain/EventBus.js';
import type { ContainerControl } from '../../src/domain/ContainerControl.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { call, type RouterTestApp } from '../support/routerTestApp.js';
import { startEngineTestApp } from '../support/engineTestApp.js';

const root = throwawayRoot('endpoint-redaction-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { profileServiceHarness } = await import('../support/profileServiceHarness.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const MANAGER_ENDPOINT = 'https://rpc.example.org/v3/manager-key';
const OWN_ENDPOINT = 'http://10.0.0.7:8545/own-key';

const beeLog = (endpoint: string) =>
  [
    'INFO bee: version 2.8.2',
    `INFO bee: using blockchain rpc endpoint ${endpoint}`,
    'ERROR bee: chain: unable to connect',
  ].join('\n');

const containersServing = (text: string): ContainerControl =>
  ({ logs: async () => text }) as unknown as ContainerControl;

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const apps: RouterTestApp[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

async function logsOf(
  profile: ReturnType<typeof makeProfile>,
  text: string,
  managerEndpoint: string | null,
): Promise<string> {
  const harness = profileServiceHarness([profile]);
  const app = await startEngineTestApp(
    harness.service,
    containersServing(text),
    managerEndpoint,
  );
  apps.push(app);
  const res = await call(app, 'GET', `/profiles/${profile.name}/containers/bee-uploader/logs`);
  assert.equal(res.status, 200);
  return String(res.body);
}

describe('the container log a page reads', () => {
  it('leaves the host of the manager’s endpoint and takes the key', async () => {
    const text = await logsOf(
      makeProfile({ name: 'stage', rpc_endpoint_source: 'manager' }),
      beeLog(MANAGER_ENDPOINT),
      MANAGER_ENDPOINT,
    );

    assert.match(text, /<rpc\.example\.org>/);
    assert.doesNotMatch(text, /manager-key/);
    // What the operator still needs from the line is untouched.
    assert.match(text, /unable to connect/);
  });

  it('does the same for the deployment’s own endpoint', async () => {
    const text = await logsOf(
      makeProfile({
        name: 'own',
        rpc_endpoint_source: 'custom',
        rpc_endpoint: OWN_ENDPOINT,
      }),
      beeLog(OWN_ENDPOINT),
      MANAGER_ENDPOINT,
    );

    assert.match(text, /<10\.0\.0\.7:8545>/);
    assert.doesNotMatch(text, /own-key/);
  });

  it('leaves a log that names no known endpoint exactly as it is', async () => {
    const plain = beeLog('https://rpc.gnosischain.com');

    assert.equal(
      await logsOf(makeProfile({ name: 'plain' }), plain, MANAGER_ENDPOINT),
      plain,
    );
  });
});

describe('what a failed deploy records', () => {
  it('keeps the key out of last_error, the events stream and the log line', async () => {
    const harness = orchestratorHarness(
      [
        makeProfile({
          name: 'stage',
          components: ['srs'],
          rpc_endpoint_source: 'custom',
          rpc_endpoint: OWN_ENDPOINT,
        }),
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      MANAGER_ENDPOINT,
    );
    const seen: ManagerEvent[] = [];
    harness.events.subscribe((event) => seen.push(event));

    await harness.orchestrator.startDeploy(harness.profiles.rows.get('stage')!, ['srs']);
    harness.runner.print(0, `assert-started: ${beeLog(OWN_ENDPOINT)}`);
    harness.runner.finish(0, 1);

    await until('the failed deploy to be recorded', () => harness.profiles.statusOf('stage') === 'ERROR');

    const stored = harness.profiles.rows.get('stage')?.last_error ?? '';
    assert.doesNotMatch(stored, /own-key/);
    assert.match(stored, /<10\.0\.0\.7:8545>/);

    const published = seen
      .filter((event) => event.type === 'profile.changed')
      .map((event) => (event.type === 'profile.changed' ? event.profile.last_error ?? '' : ''))
      .join('\n');
    assert.doesNotMatch(published, /own-key/);
  });
});
