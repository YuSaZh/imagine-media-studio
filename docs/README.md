# Documentation Map

[Chinese README](../README.md) | [English README](../README_EN.md) | [日本語 README](../README_JA.md) |
[Contributing](../CONTRIBUTING.md) | [Agent rules](../AGENTS.md)

## Current Guidance

| Topic | Entry |
| --- | --- |
| Contributor and Agent workflow | [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md), and its directory guide index |
| Pinned local/GitHub CI environment, scheduling and build caches | [CI toolchain](../.github/ci/README.md) |
| Runtime architecture and enduring boundaries | [Architecture overview](./architecture/overview.md) |
| Production UI and desktop/mobile behavior | [Workspace specification](./design-spec/workspace.md) |
| Built-in media models, aliases and operation limits | [Model capabilities](./model-capabilities.md) |
| Deployment, image channels, upgrade and rollback | [RELEASE.md](../RELEASE.md) and the README deployment examples |
| Zero-network image/video test adapter | [Mock Provider](./providers/mock-provider.md) |
| Custom Provider examples | [Custom providers](../examples/custom-providers/README.md) |
| Trusted JavaScript execution | [Adapter runtime](../apps/server/src/adapters/README.md) |
| Known limitations and pending external evidence | [Hold.md](../Hold.md) |
| Third-party scope and provenance | [Reuse audit](./third-party/reuse-audit.md), [notices](../THIRD_PARTY_NOTICES.md) |

## Historical Records

The original development plan has been retired. Its enduring rules now live in
the Agent guides, contributor guide, architecture overview, and workspace spec.
Use Git history to inspect the original plan if needed; do not resume its old PR
phase instructions or treat them as current acceptance requirements.

Files named `pr0-*` through `pr8-*` record the initial delivery milestones. Their
test counts, paths, screenshots, credential availability, single-user/Mock-only
phases, and optional-password behavior describe those milestones. They are not
current setup instructions or evidence that the current revision was tested.
`design-spec/pr1-public-reference.md` likewise records the early visual reference.
[PR 0 Mock design](./providers/pr0-mock-provider.md) retains the original image-only
contract and retired validation policy; the current Mock guide covers image
editing and asynchronous video fixtures. Dated verification files such as
`architecture/chat-image-mobile-verification.md` also apply only to their recorded scope.

Some milestone documents still explain maintained subsystems. The architecture
overview links the relevant archive, integrity, and media references. Before
changing one, read the current source/tests and relevant Agent guide; preserve
historical results while identifying any changed behavior explicitly.

When documentation disagrees with the requested behavior or implementation,
identify the conflict and update the current specification as part of the change.
Do not treat a historical document or a passing test as permission to bypass a
current product or security requirement.

## Dated Reviews

- [2026-10-09 code review and documentation audit](./reviews/2026-10-09-project-review.md): current series-operation findings, isolated reproduction evidence, remaining optimization suggestions and documentation corrections. The report preserves the original findings and records the subsequent R1–R3 fixes and their verification.

- [2026-09-10 whole-project structure and code review](./reviews/2026-09-10-project-review.md): architecture map, reproduced findings, and staged optimization suggestions. The report distinguishes the original findings from the recorded implementation results and remaining structural suggestions.
