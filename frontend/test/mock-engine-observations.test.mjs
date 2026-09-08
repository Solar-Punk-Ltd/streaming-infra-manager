import assert from 'node:assert/strict';
import { it } from 'node:test';

import { engineOverviewIdentity } from '@streaming-infra-manager/common';
import { engineRoutes } from '../dev/mock-engine.mjs';

function profileFor(has_engine_config) {
  return {
    name: 'synthetic-ome', kind: 'custom', components: ['ome', 'stream-uploader'],
    instance_id: 'synthetic-instance', engine_config_revision: 3, intent_revision: 4,
    updated_at: '2026-09-09T00:00:00.000Z', stack_version_id: 1,
    has_engine_config, engine_settings: { HLS_SEGMENT_DURATION: '7', OME_HLS_POLL_INTERVAL_MS: '750' },
  };
}

function overview(has_engine_config) {
  const profile = profileFor(has_engine_config);
  let body;
  const routes = engineRoutes({ withProfile: handler => handler, deploy() {}, publish() {}, readBody() {} });
  const get = routes.find(([method, pattern]) => method === 'GET' && pattern.test('/profiles/synthetic-ome/engine'));
  get[2]({}, { writeHead: status => assert.equal(status, 200), end: payload => { body = JSON.parse(payload); } }, profile);
  return body;
}

it('the mock emits the mandatory observation map and exact known projection', () => {
  const result = overview(false);
  assert.equal(result.observations.HLS_SEGMENT_DURATION.source, 'deployment');
  assert.deepEqual(result.effective, Object.fromEntries(Object.entries(result.observations)
    .filter(([, observation]) => observation.status === 'known').map(([key, observation]) => [key, observation.value])));
});

it('the mock does not claim stored settings control an unobserved custom file', () => {
  const result = overview(true);
  assert.equal(result.observations.HLS_SEGMENT_DURATION.source, 'unverified');
  assert.equal(result.effective.HLS_SEGMENT_DURATION, undefined);
  assert.equal(result.effective.OME_HLS_POLL_INTERVAL_MS, '750');
});

it('the mock identifies its current profile and config inputs with the shared identity', () => {
  for (const hasConfig of [false, true]) {
    assert.deepEqual(overview(hasConfig).identity, engineOverviewIdentity(profileFor(hasConfig)));
  }
});
