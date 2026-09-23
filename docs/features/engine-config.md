# Engine configuration

A deployment can use its own SRS or OvenMediaEngine configuration file when
its selected stack version advertises support. The manager checks the file,
recreates the engine, then records the outcome of startup verification.
Recovery can fail. Saving a file is not proof that publishing or playback works.

Status, 2026-09-16. Everything on this page is merged to `main-v2`. It was
written at `6dc33d1` on `feat/ai-remediation`, the head of pull request #40,
which landed. It carries T01's service caller integration, the isolated SRS
checks, the OvenMediaEngine validation and T11's effective settings. The branch
has since been deployed twice, on 2026-09-11 and 2026-09-13, recorded in
[../handover/main-v2-remediation.md](../handover/main-v2-remediation.md), so
some of this has now been seen on a host. The engine-configuration decisions
were accepted on 2026-09-07.

## File editing and effective settings

Open the deployment's engine configuration editor to inspect the selected
version's template or the stored custom file. Save checks the proposed file
before storing it and starting the engine recreation. Back to the template
removes the custom override and recreates the engine from that version's
normal template. The editor uses a plain text area and accepts at most
128 KiB of nonempty UTF-8 text.

Support comes from the version contract's `engineConfig` flag for that engine.
A version name alone does not prove support. New deployments can explicitly
choose a version in the wizard. Moving an existing deployment to another
version is outside the accepted D6 scope of the engine-configuration feature.
See [Stack versions](stack-versions.md).

The stack fills recognized placeholders at container startup. Keep placeholders
for values managed by the stack, including generated credentials, callback
addresses and ports. Do not paste credentials into documentation or test
fixtures. A custom file is stored as text, so replacing a placeholder with a
literal also stores that literal.

The settings drawer and summary show configured values with their source.
For a setting read from the environment, the manager combines the selected
version's defaults, valid host overrides and deployment overrides. Clearing
a deployment override uses the effective default, which can differ between
versions. A reliably parsed literal is labeled "Set in config file". Changing
an environment override does not change that literal.

Since 2026-09-23 the SRT latency is the one setting whose default does not
come from the version. The manager writes its own 2000 milliseconds into the
deployment's env file wherever the host sets no value of its own, labeled
"Manager default". In a file of the deployment's own it is read at
`recvlatency` in `srt_server`, the directive that decides SRS's side of the
wait on ingest, since `f42fba2` on 2026-09-23. A literal there is labeled "Set
in config file" like any other. A block that sets no `recvlatency` is shown
as SRS's own 120 milliseconds, labeled "Engine default", with one sentence
saying why, and changing the override does not change it. SRS ignores
`latency` for ingest without `recvlatency`, measured on 2026-09-23 as
[engine-control.md](engine-control.md) records. A file that still carries
only the `latency` placeholder, as one copied from the `v3.1` template does,
therefore reads as 120.

Omitted settings are labeled "Not specified". Conflicting values, unsupported
syntax and other uncertain readings are "Unverified", with a reason. The
manager checks relevant sections together instead of choosing the first
value it finds. Generated SRS sections can prevent a reliable reading of the
fields they control. OME's uploader poll interval is read independently of
the XML file. These observations describe configured input, not proof of what
the running engine loaded. Inspect its running configuration under Logs.

When the page receives a changed deployment or configuration revision, the
card and open drawer hide old observations immediately. Failed or timed-out
refreshes keep the draft text but do not restore stale values. A draft for a
deleted and recreated deployment cannot be applied to the replacement. Close
and reopen Settings to review that deployment.

A settings write is bound to the exact deployment job that reserved it. Losing
that ownership returns a conflict and preserves the draft. Validation and job
admission use one captured published build. Publication of another build before
the locked claim refuses the save before settings or job state changes.
Capturing mutable host inputs before execution remains open, and it closes with
the exact-execution slice described at the end of this page.

## What validation establishes

| Engine | Before recreation | After recreation | What a pass does not establish |
| --- | --- | --- | --- |
| SRS | The selected image's `srs -t -c` parses a temporary copy with dummy placeholder values. Each check owns its temporary directory and mounts its file read-only with `--mount`. Cleanup cannot delete another check's file. | The manager watches the recreated container for 20 seconds, checking its identity, running state and restart count. | Successful ingestion, uploader admission, Swarm delivery or playback. |
| OvenMediaEngine | Strict XML parsing and a comparison against protected paths and values from the selected version's own template. This is manager-side validation, not OME's own parser. | The same startup watch, followed by a TCP reachability check of the mapped HLS port from the manager, with a 10-second budget. | A working admission callback, usable stream or playlist, or end-to-end publishing. |

OME's protected set includes placeholder-bearing elements, bind ports,
admission providers, application names, provider and publisher element names,
and output stream mappings. Paths, values and multiplicity must match the
version's template. Sibling order can differ. A setting mapped to a supported
engine-settings field, such as segment duration or count, can replace its
placeholder with a literal that passes the same field validation.

Changing a callback route while retaining every placeholder is refused.
Malformed XML, duplicate protected structures and a faithful copy beside a
changed duplicate are refused too. Removing admission callbacks is not an
access-control measure. It can bypass the uploader's admission workflow.

A failed OME TCP connection is a diagnostic about reachability. If the engine
stayed running, that failure alone does not prove the file is bad and does not
trigger a revert. The UI retains the diagnostic. An `applied` rollout means
these bounded checks completed. It is not a publishing-ready verdict.

## Stored operations and recovery

Every apply or reset has a persisted operation. It records the deployment's
lifetime identity, configuration and operator-intent revisions, previous file,
container identity and current state. The deployment lifetime identity changes
when a deployment is deleted and recreated, even under the same name.

Apply, reset and recovery callers use the atomic configuration-operation and
deployment claim. They carry the captured build reference through execution and
check ownership again when recording completion. A failure during preparation
keeps the still-owned operation interrupted, its previous file and its original
failure evidence. A refused recovery claim does not mean the previous file was
restored. These callers do not close the remaining immutable execution and
build-hold release work, which the last section of this page describes.

Startup verification begins after the engine recreation has finished and
RUNNING is committed. A stopped engine, a restart or another demonstrated
startup failure can trigger one recovery attempt with the previous file.
Every recovery claim and write checks that the operation still owns the same
deployment and revisions. A newer edit, stop, start, deletion or replacement
supersedes the old operation. An old watcher must not undo the newer action.

The selected stack can also refuse its own startup command before the manager
commits RUNNING. That is an apply failure rather than a manager-watch failure.
If recovery then recreates the previous file successfully, the deployment is
RUNNING again while the operation remains `failed`, its reason says the
previous file is back, and the card offers Verify. A failure detected later by
the manager's watch ends `reverted` when the same recovery succeeds. These two
states distinguish where the candidate failed, while both preserve the actual
recovery outcome.

| State | Meaning and next action |
| --- | --- |
| `applying` | The operation is storing or recreating on the selected file or template. Wait for its outcome. |
| `watching` | Recreation completed and startup verification is in progress. |
| `applied` | The configured checks completed. A reset to the template completes after recreation without a custom-file watch. Inspect any OME reachability diagnostic separately. |
| `reverting` | An owned recovery attempt is restoring the recorded previous file and recreating the engine. |
| `reverted` | The new file failed startup verification and recreation on the previous file completed. |
| `failed` | Applying the file failed. Read the recorded reason, which also reports a failed recovery attempt when applicable. Verify now starts another explicit attempt. |
| `interrupted` | The manager could not finish verification or recovery. Verify now recreates on the stored file. Recreate on previous uses the file saved by the interrupted operation. |
| `superseded` | A newer action or container replaced the operation's authority. The older operation does no further recovery work, and the card says the last file was not verified. Verify now starts an attempt on what is stored. |

The engine card and open editor follow the current stored state. Recovery
actions explain when they are unavailable. They are not offered for a stopped
deployment. Recreating on the previous file can itself fail and leave ERROR.
There is no promise of uninterrupted service or guaranteed restoration.

After a manager restart, an unfinished apply or recovery becomes interrupted.
For a saved watch, the manager checks ownership and container identity again.
The same running container with zero restarts starts a fresh full watch.
Demonstrated failure can take the owned recovery path. A replacement container
supersedes the watch. An inspection outage leaves the result interrupted,
never verified. A stopped deployment is not restarted by this reconciliation.

## Persistence and API

The database stores the custom text and the operation history. Deployment
preparation writes the engine override to the deployment's data directory.
Backing up the manager checkout alone does not back up this state. Removal of
a deployment also removes its deployment data under the normal removal flow.

All engine-config routes require a signed-in session, like other deployment
edits. Reading uses `GET /profiles/:name/engine-config`. Saving uses `PUT` with
`{ "config": "..." }`. `DELETE` resets to the template. Explicit recovery uses
`POST /profiles/:name/engine-config/verify` and
`POST /profiles/:name/engine-config/restore-previous`. An accepted recreation returns
202 with a deployment snapshot. Observe the later operation state for its
outcome. A successful HTTP response does not prove playback.

## What has been checked, and where the containers are missing

Everything below is a laptop result for the container-backed harnesses. The
unit, database and browser suites run on GitHub's runners on every push and the
branch has been deployed to the host twice, as the status above says, but no
container harness and no integration file has run on a runner.

Unit, database and browser suites cover operation ownership, restart
reconciliation, isolated SRS check files, XML parsing and protected paths, and
the sources of an effective setting. They also cover the configured-value UI on
a desktop width and at 390 pixels. Every one of them substitutes the engine: the
container control is a test double and no SRS or OvenMediaEngine process starts.
A passing suite therefore proves the manager's own decisions, and never that an
engine read a file.

Two container harnesses exist for this feature and both run only when someone
starts them. `manager/test/docker/srs-check-isolation.sh` puts eight files
through the manager's own checker at once and asserts that each refusal names
the directive of its own file and no directive of any of the other seven.
`manager/test/docker/ome-admission-gate.sh` drives the isolated
publish-to-admission-to-playlist path. Both have a job in the manual workflow,
`docker-checks.yml`, which no one has dispatched, so no job of it has ever run
on a runner. Both pass on this laptop, most recently on 2026-09-10.

The gap between a parse and a start now has a test of its own, and it has never
executed. `manager/test/integration/engine-startup-failure.test.ts` is the only
place the whole rollout path would run against real containers: it takes the
version's own template with `work_dir /no/such/directory;` added, which the
manager's check accepts and the engine dies on. The observations that establish
that, taken on this laptop on 2026-09-10 against the SRS image the stack pins,
are in the file's own header. It needs the whole stack deployed on a runner, so
its first run is Levi's dispatch of the manual workflow. See
[../ci.md](../ci.md).

Fable's 2026-09-08 local T03 evidence records OvenMediaEngine `v0.21.0` with
manifest-list digest
`sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6`.
On arm64, the healthy template started, a second root and an undefined entity
were tolerated by OvenMediaEngine, and an unquoted attribute exited with code 1.
This is why the manager rejects malformed XML before recreation. That is a
recorded arm64 run from a laptop, not an amd64 result and not a funded-host
result, and it has not been repeated since.

## What is still open

Private execution copies landed on 2026-09-11, so a deployment now runs out of a
copy of its build rather than out of the immutable build directory. See "The
tree a deployment runs in" in [stack-versions.md](stack-versions.md). What that
leaves open here is T01's own remaining slice: the atomic begin and revert of a
config rollout, the creator receipt, and the release of operation holds after a
proven watch. Those repository APIs exist and nothing calls them.

T22 separately verifies authorised live Swarm delivery, and it waits for Levi's
D05 numbers and a separate authorisation to spend. Unit tests do not substitute
for any of these execution results.
