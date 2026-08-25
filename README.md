# Imagine Media Studio

Imagine Media Studio is a lightweight, self-hosted web interface for managing image and video generation through user-provided external APIs.

**PR 0, PR 1, and PR 2 are complete.** The current application includes the clean monorepo, single-container runtime, persistent internal API, encrypted Provider configuration, recoverable in-process jobs, managed media, installable PWA, responsive Gallery/Composer/Viewer flows, persistent Collections, and settings described in [`PLAN.MD`](./PLAN.MD).

## Development Status

- Node.js 24
- pnpm workspace
- React and Vite web app
- Fastify application server
- SQLite and Drizzle ORM
- AES-256-GCM Provider Secret storage
- Upload, thumbnails, posters, Range delivery, and SSRF-safe result downloads
- Durable Job state machine, outbox, and one browser SSE connection
- Optional application-password session gate
- One Docker service and one `/data` volume
- Local lint, typecheck, unit, build, and isolated Playwright preflight
- GitHub Actions quality, E2E, screenshot artifact, and Docker smoke verification

Real providers remain intentionally out of scope until PR 4 and later. PR 2 production data flows use the deterministic Mock Provider; PR 1 visual fixtures are available only behind an explicit test session key and are never a production fallback. PR 1 strict Grok Imagine L3/L4 classification remains deferred because the authenticated private reference package is not available; public unauthenticated evidence is documented without claiming pixel parity.

PR 0 evidence is recorded in [`docs/architecture/pr0-verification.md`](./docs/architecture/pr0-verification.md), and PR 2 evidence is recorded in [`docs/architecture/pr2-verification.md`](./docs/architecture/pr2-verification.md). PR 1 screenshots and the current gap report are in [`artifacts/visual/pr1`](./artifacts/visual/pr1) and [`docs/design-spec/pr1-visual-diff-report.md`](./docs/design-spec/pr1-visual-diff-report.md).

## Local Safety

This repository is developed on a host with existing services. Local dependency installation, lint, typecheck, unit tests, production builds, and Playwright tests are allowed only after confirming their temporary port is free. Do not run the project Compose stack or Docker build on this host; GitHub Actions owns container verification. Never stop, restart, rename, or inspect secrets from existing host services.

For deployment on another host, create the bind-mounted data directory as the runtime user and pass that user's numeric IDs when they differ from `1000:1000`:

```bash
mkdir -p data
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

## License

Imagine Media Studio is licensed under the [MIT License](./LICENSE). Reviewed third-party projects and future attribution requirements are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
