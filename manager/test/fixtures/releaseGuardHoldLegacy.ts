import { ReleaseGuardStore } from "../../src/releaseGuard/ReleaseGuardStore.js";

const stateRoot = process.argv[2];
if (!stateRoot) throw new Error("release guard state root is required");

const lease = await new ReleaseGuardStore(stateRoot).beginLegacyLease();
if (lease.mode !== "legacy")
  throw new Error("release guard is already managed");
process.stdout.write("locked\n");
await new Promise<never>(() => undefined);
