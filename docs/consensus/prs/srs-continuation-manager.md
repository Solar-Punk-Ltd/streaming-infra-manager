# Show SRS broadcast state and guard compatible releases

**2026-09-21, release guard removed.** The owner ruled the release guard out on 2026-09-21, and branch `feat/srs-reconnect-continuation` removes it from the manager. What this record says about the guard is history, not current behaviour.

Status: active. Published as draft PR https://github.com/Solar-Punk-Ltd/streaming-infra-manager/pull/43. Not ready to merge.
Target: `Solar-Punk-Ltd/streaming-infra-manager`, `main`.

The deployment page shows a capable SRS uploader's observed broadcast state separately from container state. It displays the reconnect deadline, reports stale observations as unavailable, and links to the owner controls in the admin app. Deployment Start, Stop and Restart retain their infrastructure meaning. Continue belongs to the admin app.

The manager enables managed lifecycle behavior for one explicitly selected SRS deployment and binds its uploader identity to the deployment's persisted instance ID. Unrelated SRS profiles retain their existing behavior. New internal credentials are routed to their consuming process and excluded from profile files, command arguments, inherited build environments and command output. Legacy admin settings remain intact when the feature is disabled.

An independently installed release guard binds supported transitions to exact candidate trees, image IDs and durable minimum capabilities. It preserves the manager's existing upgrade coordinator and exact database volume. Installation and activation share exclusion with legacy deployment. Delayed duplicate completion cannot release a newer operation's lease. Failed or interrupted transitions retain their recovery evidence. Installation and activation are separate owner-coordinated actions.

Companions: admin lifecycle/Continue and stack reconnect/media/viewer changes. The verified final stack pin remains required before readiness. The current draft does not claim that the stack pin or live installation is complete.

Validation recorded so far includes focused lifecycle parser, route and browser checks, plus 29 integrated release-guard tests at `d4511f6e`. The guard tests include a killed transition and a deliberately removed preflight that must fail. Later credential-routing/output fixes passed focused worker checks, and the integrated source/test files were compared to those exact commits. Final full manager checks remain pending.

Before readiness: complete the approved deployment entry paths, verify disabled-feature compatibility, run the final full manager suites and assembled release refusal checks, and bind the manager to the verified stack commit. The source-only SSH credential handoff still awaits owner approval after automatic approval review refused it. No live token, installation or deployment was used for that preparation.

Evidence: `docs/consensus/briefs/SRS-IMPLEMENTATION-PROGRESS.md` and `docs/testing/srs-continuation/validation-inventory.md`. Automated results, isolated runtime results and real OBS/Swarm acceptance are reported separately.

Companion drafts: [stack #242](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/242), [admin #8](https://github.com/Solar-Punk-Ltd/streaming-monorepo/pull/8), [manager #43](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/pull/43).
