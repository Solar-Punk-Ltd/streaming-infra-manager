# T23. The execution copy costs two minutes per deploy

Source: the first ABR node pool on the live host, 2026-09-17. Priority: P2. Depends on: none. Decision: Levi, 2026-09-17, "register 1 as recommended next task": hash once at publish, verify by stamps. Size: M, plus a security re-read.

Measured on 157.90.34.105 at 0696a28: the four members of `abr-pool-1` took 8 minutes 21 seconds to deploy, of which the four deploy scripts took 32 seconds. The rest, about 117 seconds per member, is `ExecutionRootService.prepare`: `inventoryOwnedTree` reads and hashes every file of the build (43,000 files, 486 MB, node_modules 411 MB) on the source, then `copyExecutionRoot` walks the stamps (a stamp here is a per-file fingerprint of device, inode, mode, size and modification time, not the Swarm postage stamp the word means elsewhere on this page), hard-links every file, walks the stamps again and hashes the whole copy a second time. That is two read-and-hash passes over the tree, the source and the copy, and four stat walks. Every step is one file at a time with about ten awaited system calls per file in `readOwnedFile`. The same hashing with `find` and `sha256sum` inside the api container takes 6 seconds, and a stat walk 0.4 seconds, so the cost is the per-file ceremony and not the disk. Members deploy one after another (`ProfileService.deployNewMembers`), so the last member waits for every copy before it.

## Scope

- Hash a build once, when it is published, and record the per-file digests and the tree digest in its manifest. A published build is never written to again, which is what the copy already relies on.
- Before a deploy, prove the build unchanged by stamps (device, inode, mode, size and modification time, never the status-change time, which every hard link moves) against the recorded inventory, which is the 0.4 second walk, and prove the copy by inode identity, since its files are hard links of the build. Read bytes only for the settings files that are copied rather than linked.
- Keep every guarantee the copy gives today: exclusive copy token, refusal on a tree that moved during the copy, refusal on a digest mismatch.
- Log a line when the preparation starts, with the file count, and pass `onProgress` through so the deployment page can show it. Nothing shows today between "Created group" and "copied build".
- Bounded concurrency over the per-file work is acceptable as a first step if the digest change needs the security re-read first.

## Acceptance

- A member deploy on a build the size of 7e2de6f7 prepares its copy in seconds, measured on the host and recorded in the handover.
- A build whose file changed after publish is refused with the same refusal, which now also names the record it was proved against, covered by a test that touches one file's bytes and one file's mode.
- A copy whose linked file is replaced by a different inode is refused.
- The unit suite keeps `deployExecutionCopy.test.ts` green.

## Where the design lives

`manager/src/domain/versions/ownedTreeInventory.ts`, `executionRootFiles.ts`, `ExecutionRootService.ts`, the T04a immutable builds design in ../PRD.md, and the 2026-09-17 section of ../../handover/main-v2-remediation.md.
