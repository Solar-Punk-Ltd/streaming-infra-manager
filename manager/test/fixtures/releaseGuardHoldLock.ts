import { ReleaseGuardStore } from '../../src/releaseGuard/ReleaseGuardStore.js';

const stateRoot = process.argv[2];
if (!stateRoot) throw new Error('release guard state root is required');

await new ReleaseGuardStore(stateRoot).withTransition(async () => {
  process.stdout.write('locked\n');
  await new Promise<never>(() => undefined);
});
