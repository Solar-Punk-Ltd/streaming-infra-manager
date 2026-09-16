# T18 narrow layouts

Cross-provider review, OpenAI-hosted. Merged to `main-v2`.

The Versions page presents each version as a card. Its name, state, default label, tested control
and actions stay visible at narrow widths. Build metadata wraps within the card. Contract detail
opens through a native keyboard-accessible disclosure. The cards require no horizontal scrolling.

Each card carries five controls, **Settings** among them, which opens that version's own
configuration files. `frontend/test/versions-layout.test.mjs` asserts the count and the
everything-fits property at 723, 390 and 1280 pixels, and it runs with the other browser suites
through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`. See
[../ci.md](../ci.md).

That suite is the live record of this behaviour. The run log this page used to carry was reduced
on 2026-09-16: its test counts had drifted, it recorded a fixed fixture port that the suite no
longer binds because it takes a kernel-assigned one, and its evidence paths were under `.scratch/`,
which is gitignored and therefore resolves to nothing on any other checkout. The task's own record
is `../consensus/issues/t18-narrow-layouts.md` and `../consensus/prs/t18-narrow-layouts.md`.
