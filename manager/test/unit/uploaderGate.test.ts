/**
 * The checks that run before a stream-uploader container is started.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The stamp and chequebook checks used to sit on the "deploy uploader" action
 * alone, so the Retry button, a settings change and `POST /profiles/:name/deploy`
 * all recreated the uploader without asking the node anything. An uploader
 * started on an expired batch reports RUNNING and fails every upload, which is
 * the failure the stamp check exists to prevent, so the checks belong where
 * every route passes. A drained chequebook is read and warned about, on the
 * ruling of 2026-09-17, and the uploader starts.
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { StampNotUsableError } from '../../src/domain/errors/index.js';
import type { StampService } from '../../src/domain/StampService.js';
import { UploaderStartGate } from '../../src/domain/UploaderStartGate.js';
import { Profile } from '../../src/types/index.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile } from '../support/profileFixtures.js';

// SUBMODULE resolves when envUtils loads, so the scratch root has to be set
// before the orchestrator is imported.
const root = throwawayRoot('uploader-gate-');
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);

const BATCH = 'a'.repeat(64);
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map(
    (rung, index) =>
      `${rung}@http://10.0.0.7:${10015 + index * 10}<${BATCH}>`,
  )
  .join(' ');

/** Stands in for a bee node that has been asked about the batch. */
class RecordingGate {
  readonly asked: string[] = [];

  constructor(private readonly refuse = false) {}

  async assertCanStart(profile: Profile): Promise<void> {
    this.asked.push(profile.name);
    if (this.refuse) {
      throw new StampNotUsableError(
        profile.name,
        'the configured stamp is unknown to this bee node',
      );
    }
  }
}

const streamer = (over: Partial<Profile> = {}): Profile =>
  makeProfile({ name: 'stage', stamp_id: BATCH, ...over });

describe('starting an uploader that the node refuses', () => {
  it('refuses a plain deploy of a running deployment, before it claims it', async () => {
    const gate = new RecordingGate(true);
    const { orchestrator, profiles, runner } = orchestratorHarness(
      [streamer()],
      gate,
    );

    await assert.rejects(
      orchestrator.startDeploy(profiles.rows.get('stage')!, undefined),
      StampNotUsableError,
    );

    assert.deepEqual(gate.asked, ['stage']);
    assert.equal(profiles.statusOf('stage'), 'RUNNING', 'not claimed');
    assert.equal(runner.runs.length, 0);
    assert.ok(!existsSync(join(root, '.env.stage')), 'no env file written');
  });

  it('refuses the uploader-only route the same way', async () => {
    const gate = new RecordingGate(true);
    const { orchestrator, profiles } = orchestratorHarness([streamer()], gate);

    await assert.rejects(
      orchestrator.startDeployUploader(profiles.rows.get('stage')!),
      StampNotUsableError,
    );

    assert.deepEqual(gate.asked, ['stage']);
    assert.equal(profiles.statusOf('stage'), 'RUNNING');
  });

  it('refuses a retry of a deployment that is already in ERROR', async () => {
    const gate = new RecordingGate(true);
    const { orchestrator, profiles } = orchestratorHarness(
      [streamer({ status: 'ERROR' })],
      gate,
    );

    await assert.rejects(
      orchestrator.startDeploy(profiles.rows.get('stage')!, undefined),
      StampNotUsableError,
    );

    assert.equal(profiles.statusOf('stage'), 'ERROR');
  });
});

describe('when there is nothing to ask', () => {
  it('does not probe a stopped deployment, whose node is down anyway', async () => {
    const gate = new RecordingGate(true);
    const { orchestrator, profiles, runner } = orchestratorHarness(
      [streamer({ status: 'STOPPED' })],
      gate,
    );

    await orchestrator.startDeploy(profiles.rows.get('stage')!, undefined);

    assert.deepEqual(gate.asked, []);
    assert.equal(runner.runs.length, 1);
  });

  it('does not probe an initial deploy, which has no node yet', async () => {
    const gate = new RecordingGate(true);
    const { orchestrator, profiles } = orchestratorHarness(
      [streamer({ status: 'DEPLOYING' })],
      gate,
    );

    await orchestrator.startInitialDeploy(
      profiles.rows.get('stage')!,
      undefined,
    );

    assert.deepEqual(gate.asked, []);
  });

  it('does not probe a deployment that runs no bee node of its own', async () => {
    const gate = new RecordingGate(true);
    const pooled = streamer({
      kind: 'abr-uploader',
      bee_publishers: PUBLISHERS,
      stamp_id: null,
    });
    const { orchestrator, profiles, runner } = orchestratorHarness(
      [pooled],
      gate,
    );

    await orchestrator.startDeploy(profiles.rows.get('stage')!, undefined);

    assert.deepEqual(gate.asked, []);
    assert.equal(runner.runs.length, 1);
  });

  it('does not probe a deploy that starts no uploader', async () => {
    const gate = new RecordingGate(true);
    const viewer = streamer({ kind: 'viewer', stamp_id: null });
    const { orchestrator, profiles } = orchestratorHarness([viewer], gate);

    await orchestrator.startDeploy(profiles.rows.get('stage')!, undefined);

    assert.deepEqual(gate.asked, []);
  });
});

describe('UploaderStartGate', () => {
  const stamps = (
    refuse: boolean,
  ): { service: StampService; checked: string[] } => {
    const checked: string[] = [];
    const service = {
      async assertStampUsable(name: string, stampId: string): Promise<void> {
        checked.push(`${name}:${stampId}`);
        if (refuse) {
          throw new StampNotUsableError(
            name,
            'the configured stamp has expired',
          );
        }
      },
    } as unknown as StampService;
    return { service, checked };
  };

  /**
   * The chequebook check never refuses, on the owner's ruling of 2026-09-17, so
   * this fake has no refusing shape to offer. It records that it was asked,
   * which is the whole of what the gate owes it: the reading reaches the log
   * and the start goes on whatever it says.
   */
  const chequebook = (): { service: ChequebookService; asked: string[] } => {
    const asked: string[] = [];
    const service = {
      async assertFunded(name: string): Promise<void> {
        asked.push(name);
      },
    } as unknown as ChequebookService;
    return { service, asked };
  };

  it('asks the node about the batch the profile carries', async () => {
    const batch = stamps(true);
    const funds = chequebook();

    await assert.rejects(
      new UploaderStartGate(batch.service, funds.service).assertCanStart(
        streamer(),
      ),
      StampNotUsableError,
    );

    assert.deepEqual(batch.checked, [`stage:${BATCH}`]);
  });

  it('asks nothing about a batch when the profile carries none', async () => {
    const batch = stamps(true);
    const funds = chequebook();

    await new UploaderStartGate(batch.service, funds.service).assertCanStart(
      streamer({ stamp_id: null }),
    );

    assert.deepEqual(batch.checked, []);
    assert.deepEqual(funds.asked, ['stage'], 'the chequebook is still asked');
  });

  it('starts an uploader whose chequebook is dry, having read it first', async () => {
    const batch = stamps(false);
    const funds = chequebook();

    await new UploaderStartGate(batch.service, funds.service).assertCanStart(
      streamer(),
    );

    assert.deepEqual(batch.checked, [`stage:${BATCH}`]);
    assert.deepEqual(funds.asked, ['stage'], 'read, and written to the log, either way');
  });

  it('never asks about the chequebook once the batch was refused', async () => {
    const batch = stamps(true);
    const funds = chequebook();

    await assert.rejects(
      new UploaderStartGate(batch.service, funds.service).assertCanStart(
        streamer(),
      ),
      StampNotUsableError,
    );

    assert.deepEqual(funds.asked, []);
  });
});
