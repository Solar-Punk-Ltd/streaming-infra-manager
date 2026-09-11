# feat: publish immutable stack builds and guard version removal (T04a)

Local draft for `fix/t04a-immutable-builds` at `c55c9d93b17b75619b239104099de28cdfff2a43`. Nothing is pushed or merged into main-v2. This is a reviewed local checkpoint. Final integration and real-engine acceptance remain open.

Updating a version previously replaced files that an existing deployment could still use. A deploy could also claim an older build after publication and pruning changed the row. Version removal checked its dependencies before its deletion transaction and could silently continue after a filesystem error.

The manager now publishes each build into its own immutable directory and names the active build in the database. Deploy admission checks the captured version under its row lock and retains an identified build reference. Missing, changed or incomplete artifacts refuse admission. Published builds never fall back to a mutable legacy root.

## Behavior

- Each added version keeps separate flat configuration, checkout and immutable-build directories. A build includes its manifest and a completion marker written last. The database records current and previous build identities. Existing rows retain their explicit legacy layout until publication.
- Host-owned inputs are captured as a committed revision under the same advisory file lock used by the editing script. The revision manifest contains hashes and is written last. Interrupted or inconsistent edits refuse capture.
- Publication retains the old usable build on failure. Deployment claims compare the selected version and build under the version lock. Initial preparation failures record an error, while a missing version or malformed build path refuses before deployment.
- Pruning keeps current, previous and explicitly referenced builds. Deployment display reports observed container commits, including mixed or unverified observations.
- Whole-version removal holds the version row lock through identity checks, dependency checks, filesystem removal and row deletion. Bundled, default, building and assigned versions refuse removal. Unresolved build references, every shipment receipt and unreleased execution records prevent deletion before any payload is removed.
- Before deleting payload, removal writes and syncs a bounded sibling tombstone. It survives a crash or database rollback, so a partially deleted artifact cannot be admitted merely because its old completion marker survived. The same version can retry removal. A later same-name row can reuse a tombstone only when its recorded version ID is older.
- Removal and admission validate owned paths, physical parents and marker identity. Arbitrary ancestor symlinks, malformed markers and future-ID markers refuse. Verified macOS temporary-directory aliases remain usable by local tests. A failed first build whose directory was never created can still be removed after safely creating the marker's parent.
- An update that loses its version while waiting for the row lock returns a refusal and never starts a build for the deleted row.

## Validation

The dependency-integrated checkpoint `4ca688c` passed all 194 actual PostgreSQL cases across 11 files, 999 manager tests, 289 common tests, 18 frontend tests and workspace typechecking. The final first-use correction `c55c9d9` then passed 45 removal SQL cases, 70 relevant unit cases and workspace types. The final tree is clean.

Regressions include both publication/prune lock orders, reference and assignment races, partial filesystem failure with surviving completion metadata, rollback and retry, malformed or substituted markers, ancestor symlinks and same-name reuse. The first-use test runs the actual service against isolated PostgreSQL with a fake runner.

The earlier offline browser check covered version/build display and a mocked version update. No real engine build, host operation or deployment ran. Full commands, RED/GREEN commits and logs are recorded in `../T04A-CONTINUATION.md`.

## Integration and limits

Migration 015 and subsequent local dependencies have run only in disposable local PostgreSQL schemas. No production migration has run. T06/T12 and the accepted T04b helper dependency are integrated on this branch. Later T04b/T01 ownership changes must preserve the deletion-marker check in their extracted claim path.

Operation-held rollback artifacts, final successful-job ownership, immutable execution preparation and remote packaging remain explicit integration work in T01/T04b. Their completion is not implied by this branch's passing tests. The later real-engine and matching-version harnesses remain unexecuted. No host cleanup of retained legacy data is included.
