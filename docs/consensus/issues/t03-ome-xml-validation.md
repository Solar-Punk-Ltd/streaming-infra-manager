# T03. Validate OME XML and describe validation honestly

Source: R08 and N01 (OME image tag `latest` unpinned). Priority: P2. Depends on: T01. Decision: none. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

The OME check is a regex tag-balance scan (omeXml.ts:11), the `<AdmissionWebhooks>` message is inverted (:59, without it OME admits every publisher that no other configured access control refuses and the uploader never learns of the stream), the dialog claims "the engine's own parser" for both engines (frontend/src/forms/EngineConfigDialog.tsx:43, true for SRS only), and the stack runs `airensoft/ovenmediaengine:latest` (deploy/docker-compose.yml:165).

## Scope

- A strict XML parser. Any dependency gets the four provenance checks (publish age, signature and provenance, `npm audit signatures`, malware advisories), with missing provenance recorded.
- The required set is derived from the version's own template by path patterns, compared by path and value, sibling order ignored: every element whose text carries a placeholder, every Port under Server/Bind, AdmissionWebhooks/Enables/Providers and its value, every Applications/Application/Name and per application the element names under Providers and Publishers and OutputProfiles/OutputProfile/OutputStreamName.
- Protected versus tunable: a placeholder that an engine settings field maps to (`EngineSettingField.placeholder`, today segment duration and count) may stay a placeholder or become a literal that passes that field's validation, and T11 reports the setting as controlled by the file. Everything else in the set (callback URL, secret, bind ports, admission, application paths, stream-name mapping) is protected.
- N01: resolve the tag the template was written against, run the two malformed files and the healthy control against that identity with exit code and log outcome recorded, then record `airensoft/ovenmediaengine:<version>@sha256:<digest>` in the stack. The stack change is Levi's commit. No pull or test on the funded host.
- After the recreate, a TCP connect to the mapped HLS port from the api container, bounded startup window, liveness only. "Could not reach" is diagnostic and distinct from a demonstrated bad file.
- An isolated SRT to admission to HLS test with a fake uploader and no funds is the integration gate. T22 verifies Swarm delivery later.
- Copy after T01: SRS reads the file with its own parser before anything changes. OME gets manager-side validation, then bounded startup checks with a recovery attempt if they fail. No promise that the previous engine always recovers.

## Acceptance

- Multiple roots, invalid entities and malformed attributes are refused before recreation. Comments, CDATA and supported XML forms remain accepted.
- The bundled template with only the segment-duration placeholder literalised is accepted and shown as file-controlled. The same template with only the callback route changed, every placeholder still present, is refused.
- A container that stays running while these paths fail never receives a publishing-ready verdict.
- Image reference and digest, startup outcome and the healthy control are recorded for the pinned pair.

## Where the design lives

PRD "**Question 3, T03's contract**" (Fable round 2), "##### Question 3. T03 path-pattern contract and pinned pair" (OpenAI round 3), "##### Question 3, T03" (Fable round 3), the T03 paragraph in OpenAI round 4 Question 2.

## Code anchors

manager/src/domain/engineConfig/omeXml.ts, engineConfigCheck.ts, common/src/engineSettings.ts (:197, :209 placeholder map), common/src/engineConfig.ts:89, frontend EngineConfigDialog.tsx:36 to :43, stack engines/ome/Server.xml.template, packages/stream-uploader/src/engines/ome.ts :78 to :85 and :107 to :170, deploy/docker-compose.yml:165 and :169.
