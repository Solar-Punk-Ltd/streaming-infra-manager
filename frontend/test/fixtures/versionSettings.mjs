/**
 * One version's settings as the manager answers them, for the offline page.
 *
 * The values are obviously fake on sight. Nothing here is a credential, and
 * nothing here came off a host.
 */

const BASE_ENTRIES = [
  { key: 'STAMP', value: '', sampleValue: '', description: '', secret: false, generated: false },
  {
    key: 'STREAM_KEY',
    value: '',
    sampleValue: '',
    description: 'The key the uploader signs the feed with.',
    secret: true,
    generated: true,
  },
  {
    key: 'API_AUTH_TOKEN',
    value: 'not-a-real-secret',
    sampleValue: '',
    description:
      'Bearer token for every gated route. Required, with no unauthenticated mode, because every accepted segment spends postage stamp money. Minimum 32 characters.',
    secret: true,
    generated: true,
  },
  {
    key: 'PUBLISH_KEY_SECRET',
    value: '',
    sampleValue: '',
    description: 'Publisher authentication, off when empty.',
    secret: true,
    generated: false,
  },
  { key: 'API_PORT', value: '3000', sampleValue: '3000', description: '', secret: false, generated: false },
  { key: 'ENGINE', value: 'srs', sampleValue: 'srs', description: '', secret: false, generated: false },
  {
    key: 'EXTRA_LOCAL_KEY',
    value: 'kept',
    sampleValue: null,
    description: '',
    secret: false,
    generated: false,
  },
];

const ENGINE_ENTRIES = [
  { key: 'ABR_ENABLED', value: 'false', sampleValue: 'false', description: '', secret: false, generated: false },
  {
    key: 'SRT_PASSPHRASE',
    value: 'not-a-real-passphrase',
    sampleValue: '',
    description: '',
    secret: true,
    generated: true,
  },
  {
    key: 'SRS_WEBHOOK_TOKEN',
    value: '',
    sampleValue: '',
    description:
      'Shared secret SRS carries in its webhook URL. Required, with no unauthenticated mode. Unreserved URL characters only, minimum 32.',
    secret: true,
    generated: true,
  },
  { key: 'SRS_ADAPTER_PORT', value: '3000', sampleValue: '3000', description: '', secret: false, generated: false },
];

export function seedSettings() {
  return {
    generation: 4,
    buildId: '3333333333333333333333333333333333333333-r2',
    files: [
      { path: '.env', kind: 'env', entries: structuredClone(BASE_ENTRIES) },
      {
        path: 'deploy/config.json',
        kind: 'json',
        text: '{\n  "services": ["srs"]\n}\n',
        sampleText: '{\n  "services": []\n}\n',
      },
      { path: 'engines/srs/.env', kind: 'env', entries: structuredClone(ENGINE_ENTRIES) },
    ],
  };
}
