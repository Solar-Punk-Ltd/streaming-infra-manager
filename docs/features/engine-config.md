# Engine configuration

A deployment can use its own SRS or OvenMediaEngine configuration file when
its selected stack version advertises support. The manager checks the file,
recreates the engine, then records the outcome of startup verification.
Recovery can fail. Saving a file is not proof that publishing or playback works.

This page describes the agreed remediation included in the local `main-v2`
integration checkpoint `4372848` on 2026-09-09. It includes T01's service caller
integration through `82e2d08`, the isolated SRS checks, OME validation and T11's
effective settings. Aggregate verification and immutable execution integration
remain open. No host deployment of this remediation is claimed here. The
engine-configuration decisions were accepted on 2026-09-07.

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

Omitted settings are labeled "Not specified". Conflicting values, unsupported
syntax and other uncertain readings are "Unverified", with a reason. The
manager checks relevant sections together instead of choosing the first
value it finds. Generated SRS sections can prevent a reliable reading of the
fields they control. OME's uploader poll interval is read independently of
the XML file. These observations describe configured input, not proof of what
the running engine loaded. Inspect its running configuration under Logs.

When the page receives a changed deployment or configuration revision, the
card and open drawer hide old observations immediately. Failed or timed-out refreshes keep the
draft text but do not restore stale values. A draft for a deleted and
recreated deployment cannot be applied to the replacement. Close and reopen
Settings to review that deployment.

The accepted local T11 checkpoint `ef269a8` also binds the settings write to
the exact deployment job that reserved it. Losing that ownership returns a
conflict and preserves the draft. Validation and job admission use one
captured published build. Publication of another build before the locked
claim refuses the save before settings or job state changes. Capturing mutable
host inputs before execution remains open. This checkpoint is included in the
local merge, without a claim of host deployment.

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

Apply, reset and recovery callers now use the atomic configuration-operation
and deployment claim. They carry the captured build reference through execution and
check ownership again when recording completion. A failure during preparation
keeps the still-owned operation interrupted, its previous file and its original
failure evidence. A refused recovery claim does not mean the previous file was
restored. These caller changes do not close the remaining immutable execution
and build-hold release integration.

Startup verification begins after the engine recreation has finished and
RUNNING is committed. A stopped engine, a restart or another demonstrated
startup failure can trigger one recovery attempt with the previous file.
Every recovery claim and write checks that the operation still owns the same
deployment and revisions. A newer edit, stop, start, deletion or replacement
supersedes the old operation. An old watcher must not undo the newer action.

| State | Meaning and next action |
| --- | --- |
| `applying` | The operation is storing or recreating on the selected file or template. Wait for its outcome. |
| `watching` | Recreation completed and startup verification is in progress. |
| `applied` | The configured checks completed. A reset to the template completes after recreation without a custom-file watch. Inspect any OME reachability diagnostic separately. |
| `reverting` | An owned recovery attempt is restoring the recorded previous file and recreating the engine. |
| `reverted` | The new file failed startup verification and recreation on the previous file completed. |
| `failed` | Applying the file failed. Read the recorded reason, which also reports a failed recovery attempt when applicable. Verify now starts another explicit attempt. |
| `interrupted` | The manager could not finish verification or recovery. Verify now recreates on the stored file. Recreate on previous uses the file saved by the interrupted operation. |
| `superseded` | A newer action or container replaced the operation's authority. The older operation does no further recovery work. |

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

## Verification still needed before release

Local regressions cover operation ownership, restart reconciliation, isolated
SRS check files, XML parsing and protected paths, and effective-setting sources.
The T11 exact-job write checkpoint passed 18 database, 27 focused HTTP and
13 browser checks, plus workspace types. Before T01's service caller integration,
its full manager run passed 1095 of 1097 cases. Those two failures concerned
configuration-operation and deployment-claim integration. This is historical
evidence, not a test result for the merged branch. The later same-build capture
correction passed 28 targeted HTTP/unit checks, three database cases and manager
types. The full suite was not repeated for that checkpoint. T01's later
`82e2d08` includes the atomic service and retained-recovery corrections.
The configured-value UI also has desktop and 390-pixel responsive browser
review. These checks are separate from running the real engine containers.

Fable's 2026-09-08 local T03 evidence records OME `v0.21.0` with manifest-list
digest `sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6`.
On arm64, the healthy template started, a second root and an undefined entity
were tolerated by OME, and an unquoted attribute exited with code 1. This is
why the manager must reject malformed XML before recreation. The same recorded
local run passed the isolated SRT-to-admission-to-HLS gate with a signed opening
callback, a media segment and a closing callback. Codex has not rerun that
container evidence in this continuation.

Levi still owns the stack image-pin change. T20 must integrate these regressions
with the real SRS parser concurrency check and the combined CI workflow. The
recorded arm64 result is not an amd64 CI run or a funded-host result. T11's
mutable-input integration remains open as described above.
T01 still needs immutable execution and build-hold release verification across
the combined paths. T04b's fixed production publication CLI and private runtime
wiring remain open dependencies. The atomic operation claim, retained recovery
and deployment-completion service callers are now connected, but their local
integration still needs combined verification. T22 separately verifies
authorized live Swarm delivery. Unit tests do not substitute for these
execution results.
