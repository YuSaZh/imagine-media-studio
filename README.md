# Imagine Media Studio

Imagine Media Studio is a lightweight, self-hosted web interface for managing image and video generation through user-provided external APIs.

**PR 0 and the PR 1 functional UI Shell are complete.** The current application includes the clean monorepo, single-container runtime skeleton, SQLite persistence, Mock Provider, installable PWA, responsive Gallery/Composer/Viewer flows, Library routes, and settings shell described in [`PLAN.MD`](./PLAN.MD).

## Development Status

- Node.js 24
- pnpm workspace
- React and Vite web app
- Fastify application server
- SQLite and Drizzle ORM
- One Docker service and one `/data` volume
- Local lint, typecheck, unit, build, and isolated Playwright preflight
- GitHub Actions quality, E2E, screenshot artifact, and Docker smoke verification

Real providers remain intentionally out of scope until PR 4 and later. PR 1 uses only deterministic Mock fixtures and passed remote functional acceptance. Its strict Grok Imagine L3/L4 classification remains deferred because the authenticated private reference package is not available; public unauthenticated evidence is documented without claiming pixel parity.

PR 0 evidence is recorded in [`docs/architecture/pr0-verification.md`](./docs/architecture/pr0-verification.md). PR 1 screenshots and the current gap report are in [`artifacts/visual/pr1`](./artifacts/visual/pr1) and [`docs/design-spec/pr1-visual-diff-report.md`](./docs/design-spec/pr1-visual-diff-report.md).

## Local Safety

This repository is developed on a host with existing services. Local dependency installation, lint, typecheck, unit tests, production builds, and Playwright tests are allowed only after confirming their temporary port is free. Do not run the project Compose stack or Docker build on this host; GitHub Actions owns container verification. Never stop, restart, rename, or inspect secrets from existing host services.

For deployment on another host, create the bind-mounted data directory as the runtime user and pass that user's numeric IDs when they differ from `1000:1000`:

```bash
mkdir -p data
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

## License

Imagine Media Studio is licensed under the [MIT License](./LICENSE). Reviewed third-party projects and future attribution requirements are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
