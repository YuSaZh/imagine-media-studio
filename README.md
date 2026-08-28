# Imagine Media Studio

Imagine Media Studio is a lightweight, self-hosted web interface for managing image and video generation through user-provided external APIs.

**PR 0 through PR 7 implementation and automated acceptance are complete; the PR 8 source is prepared as the v0.1.0 release candidate.** The current application includes the clean monorepo, single-container runtime, persistent internal API, encrypted Provider configuration, recoverable in-process jobs, managed media, installable and offline-capable PWA, responsive Gallery/Composer/Viewer flows, persistent Collections, settings, protocol-fixture-verified image and video Provider profiles, custom Provider management, bounded Gallery history, mobile gestures, automated accessibility/performance gates, and the PR 8 security, integrity, archive, repair, visual-regression, and release-pipeline work described in [`PLAN.MD`](./PLAN.MD). The `v0.1.0` tag, GitHub Release, and GHCR image are not created by source preparation; the tag workflow must still pass. Real-platform PWA installation, private-reference visual evidence, and the other external boundaries remain explicit in [`Hold.md`](./Hold.md).

## Development Status

- Node.js 24
- pnpm workspace
- React and Vite web app
- Fastify application server
- SQLite and Drizzle ORM
- AES-256-GCM Provider Secret storage
- Upload, thumbnails, posters, Range delivery, and SSRF-safe result downloads
- Bounded multi-reference upload, browser image preprocessing, and role-aware Composer inputs
- Full-screen desktop/mobile Mask editor with durable parent-child Assets
- Durable Job state machine, outbox, and one browser SSE connection
- Mock async video generation for text, first-frame image, and multi-reference image inputs
- `openai-videos-v1-compatible`, `gemini-veo-operation-v1`, `gemini-omni-interactions-video-v1`, and `xai-imagine-video-v1` video profiles
- Durable video polling with provider deadlines and result expiry, cancel/retry handling, and SQLite restart recovery
- Native video viewing with controls, inline playback, poster delivery, download, and HTTP Range support
- Workbox `NetworkFirst` v2 runtime caching limited to same-origin successful poster/thumbnail responses, with direct media `401` cache eviction; complete videos, Provider URLs, URL credentials, query/Range, and Authorization-bearing requests are excluded
- Central bounded durable result manifests for Provider outputs, with server-only credentials and no secret media URLs
- Optional application-password session gate
- One Docker service and one `/data` volume
- OpenAI Images/Responses, Gemini Native/Interactions, and xAI Imagine image profiles with capability-driven model catalogs
- Bounded SSRF-safe Provider HTTP transport with response limits, timeouts, and server-only credentials
- Durable JobRunner stage retries with Provider `retry-after` handling
- Declarative custom HTTP adapters with bounded JSON/YAML parsing, JSON/form/multipart bodies, path/status/result extraction, request schemas, capability previews, dry runs, redacted previews, simulation, and path tests
- Administrator-installed Trusted JavaScript adapters with immutable manifest/source digests, worker execution, exact host allowlists, bounded resource/output limits, and SafeHttpPort-only network access
- Session-scoped offline Gallery/Job snapshots, offline-safe Prompt drafts, PWA install/update guidance, and cold-launch recovery without browser-side secrets or generated POST caching
- Infinite Gallery/Job pagination with bounded history, stable deduplication, virtual rendering, and serialized optimistic mutations with failure rollback
- Eight-viewport PR 7 interaction coverage plus representative axe WCAG 2A/2AA, JavaScript resource, and CLS gates
- Immutable SQLite migration checksums, bounded integrity reporting, and authenticated online database backups
- Bounded media consistency reconciliation with a durable queue and one-shot safe thumbnail/poster repair
- Offline full-data archive create/verify/target-only restore with server/CLI mutual exclusion
- Four-viewport repository-owned pixel-diff baselines that remain separate from private Grok and physical-device evidence
- Tag-gated amd64/arm64 GHCR candidate build, digest smoke, delayed stable-tag promotion, SBOM/provenance, artifact attestation, and GitHub Release automation
- Local dependency installation, lint, typecheck, and unit checks
- GitHub Actions quality/build, E2E, screenshot artifact, and single-container Docker smoke verification

PR 4 image and PR 5 video adapters are verified against official-protocol fixtures, injected HTTP, deterministic Mock workflows, and the single-container runtime boundary. No production external credentials or live Provider endpoints were used; credentialed external acceptance remains pending in [`Hold.md`](./Hold.md). PR 1 visual fixtures are available only behind an explicit test session key and are never a production fallback. PR 1 strict Grok Imagine L3/L4 classification remains deferred because the authenticated private reference package is not available; public unauthenticated evidence is documented without claiming pixel parity.

PR 0 evidence is recorded in [`docs/architecture/pr0-verification.md`](./docs/architecture/pr0-verification.md), PR 2 evidence in [`docs/architecture/pr2-verification.md`](./docs/architecture/pr2-verification.md), PR 3 evidence in [`docs/architecture/pr3-verification.md`](./docs/architecture/pr3-verification.md), and PR 4 evidence in [`docs/architecture/pr4-verification.md`](./docs/architecture/pr4-verification.md). PR 1 screenshots and the current gap report are in [`artifacts/visual/pr1`](./artifacts/visual/pr1) and [`docs/design-spec/pr1-visual-diff-report.md`](./docs/design-spec/pr1-visual-diff-report.md).
PR 3 desktop/mobile screenshots and visual review are in [`artifacts/visual/pr3`](./artifacts/visual/pr3) and [`artifacts/visual/pr3/visual-diff-report.md`](./artifacts/visual/pr3/visual-diff-report.md).
PR 5 video, restart, media-delivery, and PWA evidence is recorded in [`docs/architecture/pr5-verification.md`](./docs/architecture/pr5-verification.md).
PR 5 offline media acceptance covers a known recent Poster while the installed app is already controlled by its Service Worker. PR 7 now adds bounded, session-scoped cold-offline Gallery and Job reconstruction, Prompt draft recovery, and reconnect refresh without enabling offline writes.
PR 6 custom Provider examples and the feature/security acceptance matrix are in [`examples/custom-providers`](./examples/custom-providers) and [`docs/architecture/pr6-verification.md`](./docs/architecture/pr6-verification.md). Local acceptance covered 95 test files / 828 tests, lint, typecheck, production build, E2E TypeScript compilation, Playwright (61 passed / 19 skipped), and an isolated Docker smoke. GitHub Actions run [33140963119](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119) for commit `79a30f2` passed the quality, Playwright, and single-container smoke jobs.
PR 7 automated acceptance is recorded in [`docs/architecture/pr7-verification.md`](./docs/architecture/pr7-verification.md), with accessibility/performance details in [`docs/architecture/pr7-a11y-performance.md`](./docs/architecture/pr7-a11y-performance.md) and fixed-viewport evidence in [`artifacts/visual/pr7`](./artifacts/visual/pr7). GitHub Actions run [33174754136](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136) passed all 13 quality, Docker, base E2E, PR 7 viewport, axe, and performance jobs for commit `a58ab7b`.

## Local Safety

This repository is developed on a host with existing services. Checks that start the application, Playwright, or Docker/Compose must use task-owned temporary data, a unique Compose project/resource namespace, and a non-conflicting port. Never stop, restart, rename, inspect secrets from, or otherwise alter existing host services and containers.

For deployment on another host, create the bind-mounted data directory as the runtime user and pass that user's numeric IDs when they differ from `1000:1000`:

```bash
mkdir -p data
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

Offline archive operations are available through `pnpm data-archive` after a
production build. `create` requires the application to be stopped; `verify` is
read-only and may run while it is online; `restore` creates an absent target
directory and never replaces the active `/data` mount. The complete host and
Docker operator sequence is documented in
[`docs/architecture/pr8-data-archive.md`](./docs/architecture/pr8-data-archive.md).

## Release and upgrade

The release history and known v0.1.0 boundaries are in
[`CHANGELOG.md`](./CHANGELOG.md). Digest-pinned installation, secret handling,
online and full-data backup, migration, restore, rollback, GHCR attestation,
SBOM, and provenance instructions are in [`RELEASE.md`](./RELEASE.md). Treat the
root `package.json` as the release version gate; the server and web app manifests
track that product version, while private internal library workspaces retain
their independent placeholder versions.

## Custom Provider usage

Open Settings -> Providers -> Manage adapter for a `Custom HTTP Adapter` or
`Trusted JavaScript Adapter` Provider. The ready-to-import declarations are in
[`examples/custom-providers`](./examples/custom-providers). Configure the
Provider Base URL separately and enter the write-only secret named by
`secretRef`/`requiredSecrets`; example files never contain secret values or
actual Provider URLs. Run validation, capability preview, redacted request
preview, Dry Run, simulation, and path tests before saving a revision.

Trusted JavaScript installation is administrator-only and is explicitly trusted
server-side code, not a sandbox. Review the exact source digest, host allowlist,
secret names, and resource limits before installation. The worker exposes only
the host-injected `SafeHttpPort`; dynamic imports, package installation, direct
network globals, process access, and unbounded output are rejected or bounded.
All Provider credentials stay server-side, encrypted at rest, excluded from
browser DTOs, logs, PWA caches, and exported configuration.

## License

Imagine Media Studio is licensed under the [MIT License](./LICENSE). Reviewed third-party projects and future attribution requirements are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
