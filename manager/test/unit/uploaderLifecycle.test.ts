import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STREAM_UPLOADER_SERVICE } from '@streaming-infra-manager/common';

import type { ContainerControl } from '../../src/domain/ContainerControl.js';
import type { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import type { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import {
  UploaderLifecycleService,
  lifecycleReading,
} from '../../src/domain/UploaderLifecycleService.js';
import type { StackVersionRepository } from '../../src/domain/versions/StackVersionRepository.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-09-20T00:00:10.000Z';

function payload(stream: Record<string, unknown>) {
  return { lifecycleVersion: 1, observedAt, streams: [stream] };
}

function stream(
  state: string,
  lastObservedAt = '2026-09-20T00:00:00.000Z',
): Record<string, unknown> {
  const permission =
    state === 'ready'
      ? 'open'
      : state === 'closed' || state === 'vod'
        ? 'closed'
        : 'claimed';
  return {
    streamId: 'stage/source',
    adminStreamId: ADMIN_ID,
    runNumber: 2,
    state,
    permission,
    ...(state === 'waiting'
      ? { reconnectDeadline: '2026-09-20T00:01:00.000Z' }
      : {}),
    ...(state === 'closed' ? { closeReason: 'reconnect_timeout' } : {}),
    lastObservedAt,
  };
}

describe('uploader lifecycle response', () => {
  it('keeps only validated public lifecycle fields and the source-relative age', () => {
    const reading = lifecycleReading(
      payload({
        ...stream('live'),
        token: 'secret',
        checkpointPath: '/private/state',
        nested: { claimId: 'secret' },
      }),
    );

    assert.deepEqual(reading, {
      state: 'available',
      streams: [
        {
          adminId: ADMIN_ID,
          runNumber: 2,
          state: 'live',
          initialAgeMs: 10_000,
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(reading),
      /secret|checkpoint|claim|streamId/i,
    );
  });

  it('refuses malformed and unsupported payloads atomically', () => {
    const invalid = [
      { lifecycleVersion: 2, observedAt, streams: [] },
      payload({ ...stream('live'), adminStreamId: 'not-a-uuid' }),
      payload({ ...stream('live'), streamId: '' }),
      payload({ ...stream('live'), streamId: 'x'.repeat(257) }),
      payload({ ...stream('live'), runNumber: Number.MAX_SAFE_INTEGER + 1 }),
      payload({ ...stream('live'), permission: 'open' }),
      payload({ ...stream('ready'), permission: 'claimed' }),
      payload({ ...stream('waiting'), reconnectDeadline: undefined }),
      payload({ ...stream('live'), reconnectDeadline: observedAt }),
      payload({ ...stream('closed'), closeReason: 'operator-made-this-up' }),
      payload({ ...stream('vod'), closeReason: 'cancelled' }),
      payload({
        ...stream('live'),
        lastObservedAt: '2026-09-20T00:00:11.000Z',
      }),
      {
        lifecycleVersion: 1,
        observedAt,
        streams: Array.from({ length: 101 }, () => stream('live')),
      },
    ];

    for (const value of invalid) {
      assert.deepEqual(lifecycleReading(value), {
        state: 'unavailable',
      });
    }
  });

  it('expires active state from uploader-relative age at the thirty-second boundary', () => {
    assert.equal(
      lifecycleReading(
        payload(stream('waiting', '2026-09-19T23:59:40.000Z')),
      ).state,
      'available',
    );
    assert.deepEqual(
      lifecycleReading(
        payload(stream('waiting', '2026-09-19T23:59:39.999Z')),
      ),
      { state: 'unavailable' },
    );
  });

  it('derives freshness and the reconnect countdown only from uploader timestamps', () => {
    for (const [sourceObservedAt, lastObservedAt, reconnectDeadline] of [
      [
        '2026-09-19T23:55:10.000Z',
        '2026-09-19T23:55:00.000Z',
        '2026-09-19T23:56:00.000Z',
      ],
      [
        '2026-09-20T00:05:10.000Z',
        '2026-09-20T00:05:00.000Z',
        '2026-09-20T00:06:00.000Z',
      ],
    ]) {
      assert.deepEqual(
        lifecycleReading({
          lifecycleVersion: 1,
          observedAt: sourceObservedAt,
          streams: [
            { ...stream('waiting', lastObservedAt), reconnectDeadline },
          ],
        }),
        {
          state: 'available',
          streams: [
            {
              adminId: ADMIN_ID,
              runNumber: 2,
              state: 'waiting',
              initialAgeMs: 10_000,
              deadlineRemainingMs: 50_000,
            },
          ],
        },
      );
    }
  });

  it('projects validated closed reasons without private lifecycle fields', () => {
    for (const closeReason of [
      'reconnect_timeout',
      'cancelled',
      'recovery_required',
      'finalization_failed',
      'empty',
    ]) {
      assert.deepEqual(
        lifecycleReading(payload({ ...stream('closed'), closeReason })),
        {
          state: 'available',
          streams: [
            {
              adminId: ADMIN_ID,
              runNumber: 2,
              state: 'closed',
              initialAgeMs: 10_000,
              closeReason,
            },
          ],
        },
      );
    }
  });

  it('refuses waiting deadlines outside the sixty-second reconnect window', () => {
    for (const reconnectDeadline of [
      '2026-09-20T00:00:09.999Z',
      '2026-09-20T00:01:10.001Z',
    ]) {
      assert.deepEqual(
        lifecycleReading(
          payload({ ...stream('waiting'), reconnectDeadline }),
        ),
        { state: 'unavailable' },
      );
    }
  });

  it('keeps closed and VOD facts after the active freshness window', () => {
    for (const state of ['closed', 'vod']) {
      assert.equal(
        lifecycleReading(
          payload(stream(state, '2026-09-19T22:00:00.000Z')),
        ).state,
        'available',
      );
    }
  });
});

describe('UploaderLifecycleService', () => {
  function service(
    options: {
      profile?: {
        name: string;
        host: string | null;
        stack_version_id: number;
      } | null;
      uploader?: boolean;
      capable?: boolean;
      answer?: string | Error;
    } = {},
  ) {
    const calls: string[] = [];
    const profile =
      options.profile === undefined
        ? { name: 'stage', host: null, stack_version_id: 8 }
        : options.profile;
    const profiles = {
      findByName: async () => profile,
    } as unknown as ProfileRepository;
    const containers = {
      listApiContainers: async () =>
        options.uploader === false
          ? []
          : [
              {
                service: STREAM_UPLOADER_SERVICE,
                ports: {},
                buildId: null,
                buildCommit: null,
              },
            ],
    } as unknown as ContainerRepository;
    const versions = {
      findById: async () => ({
        contract: {
          features: { srsLifecycleV1: options.capable !== false },
        },
      }),
    } as unknown as StackVersionRepository;
    const control = {
      uploaderLifecycle: async (name: string) => {
        calls.push(name);
        if (options.answer instanceof Error) throw options.answer;
        return options.answer ?? JSON.stringify(payload(stream('live')));
      },
    } as unknown as ContainerControl;
    return {
      calls,
      lifecycle: new UploaderLifecycleService(
        profiles,
        containers,
        versions,
        control,
      ),
    };
  }

  it('reads only a locally running uploader from a capable immutable stack', async () => {
    const fixture = service();

    assert.equal((await fixture.lifecycle.read('stage')).state, 'available');
    assert.deepEqual(fixture.calls, ['stage']);
  });

  it('does not infer runtime enrollment from stack capability alone', async () => {
    const fixture = service({ uploader: false });

    assert.deepEqual(await fixture.lifecycle.read('stage'), {
      state: 'unavailable',
    });
    assert.deepEqual(fixture.calls, []);
  });

  it('does not execute against a remote target until remote control is supported', async () => {
    const fixture = service({
      profile: {
        name: 'stage',
        host: 'media-host',
        stack_version_id: 8,
      },
    });

    assert.deepEqual(await fixture.lifecycle.read('stage'), {
      state: 'unavailable',
    });
    assert.deepEqual(fixture.calls, []);
  });

  it('does not ask an uploader whose selected build lacks the capability', async () => {
    const fixture = service({ capable: false });

    assert.deepEqual(await fixture.lifecycle.read('stage'), {
      state: 'unavailable',
    });
    assert.deepEqual(fixture.calls, []);
  });

  it('turns disappearance, command failure and malformed output into unavailable', async () => {
    for (const answer of [
      new Error('container disappeared'),
      '{not json',
      JSON.stringify(payload({ ...stream('live'), permission: 'open' })),
    ]) {
      const fixture = service({ answer });
      assert.deepEqual(await fixture.lifecycle.read('stage'), {
        state: 'unavailable',
      });
    }
  });
});
