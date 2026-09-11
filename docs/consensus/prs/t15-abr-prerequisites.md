# Preserve the uploader draft while creating its storage pool

An ABR uploader that needs a local storage pool can now create one from Settings and return to the same draft. Successful creation selects the exact compatible pool and shows remaining member readiness. Returning never submits the uploader automatically.

Branch: `codex/t15-pool-prerequisites`, reviewed checkpoint `8d326aa229607aea0abd111ac3e6ada17d2107f2`. Dependencies include T12's independent readiness scope and T08's version selection corrections. Local draft only.

## Behavior

- The nested pool form inherits only host and version choices. Uploader settings, private fields and source choices stay in the outer draft's memory. Cancellation restores the draft. Sign-out, outer cancellation and supersession prevent a late response from restoring it.
- Creation responses are validated before using group or member fields. An accepted but unusable response keeps the uploader draft and explains the uncertainty without repeating creation.
- Selection uses the returned compatible group ID. The creation overlay retires once global state catches up. A separate fresh membership check continues after retirement and excludes an absent or incompatible pool even if an older global response arrives later.
- Funding, postage and unknown member observations remain visible. External pools, custom deployments and existing group behavior remain available.

## Validation

Test-first checks cover draft preservation, accepted JSON validation, exact group selection, stale membership ordering and bounded cancellation. The actual offline Chrome workflow covers success, cancellation, delayed responses and both final membership-response orders. The last workflow passed in 9.85 seconds. The frontend suite passed 28 tests at the wiring checkpoint, seven inherited T08 browser cases passed, and relevant workspace/frontend typechecks and diff checks passed. The final commit contains the identical source already verified by the final browser and type runs.

The narrow browser screenshot was visually reviewed. Test browser processes and listeners were removed by exact identity. No host, live funds, dependency change or external publication was involved.

## Integration limits

The newer T12 phase and T11 settings corrections, T09's final UI and T20's portable browser harness wiring remain separate aggregate work. Navigation names are still recommendations for Levi's walkthrough. This change does not rename or remove resource capabilities.
