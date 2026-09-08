export const LONG_VERSION_NAME = 'review-version-with-forty-characters-1234';
export const LONG_ERROR = `The last build failed while reading ${'verylongdirectory'.repeat(16)}. The previous build is still active.`;

const contract = {
  ports: [{ name: 'API_PORT', defaultPort: 3000, slotBase: 10000 }],
  maxSlot: 99,
  requiredSecrets: ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'],
  engineDefaults: { HLS_WINDOW: '15' },
  features: { srsApiPort: true, chequebookGate: true },
  chequebookMinBzz: '0.5',
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: 'airensoft/ovenmediaengine:0.18.0' },
  warnings: [`Unrecognized port declaration: ${'VERY_LONG_PORT_NAME_'.repeat(10)}`],
};

function version(id, input) {
  const commit = String(id).repeat(40);
  return {
    id, name: `version-${id}`, gitRef: 'main-v3', commitSha: commit,
    status: 'ready', tested: false, isDefault: false,
    builtAt: '2026-09-08T10:00:00.000Z', lastError: null,
    contract: structuredClone(contract), deployments: 0,
    layout: 'builds', buildId: `${commit}-r2`, previousBuildId: commit,
    ...input,
  };
}

export function seedVersions() {
  return [
    version(1, {
      name: LONG_VERSION_NAME, gitRef: 'feature/' + 'verylongbranchname'.repeat(5),
      tested: true, isDefault: true, deployments: 3, lastError: LONG_ERROR,
    }),
    version(2, { name: 'bundled', layout: 'legacy', buildId: null, previousBuildId: null, tested: true }),
    version(3, { name: 'candidate' }),
    version(4, {
      name: 'failed-first-build', status: 'failed', commitSha: null,
      builtAt: null, contract: null, buildId: null, previousBuildId: null,
      lastError: LONG_ERROR,
    }),
    version(5, {
      name: 'building-first-version', status: 'building', commitSha: null,
      builtAt: null, contract: null, buildId: null, previousBuildId: null,
    }),
    version(6, { name: 'rebuilding-tested-version', status: 'building', tested: true }),
  ];
}
