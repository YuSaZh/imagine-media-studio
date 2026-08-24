# Imagine Media Studio

Imagine Media Studio is a lightweight, self-hosted web interface for managing image and video generation through user-provided external APIs.

**PR 0 is complete.** It establishes the clean monorepo, single-container runtime skeleton, SQLite persistence, Mock Provider, minimal PWA, and UI reference process described in [`PLAN.MD`](./PLAN.MD).

## Development Status

- Node.js 24
- pnpm workspace
- React and Vite web app
- Fastify application server
- SQLite and Drizzle ORM
- One Docker service and one `/data` volume
- Build, E2E, and Docker smoke verification in GitHub Actions

Real providers and the final Grok Imagine-referenced interface are intentionally out of scope until their planned phases.

The acceptance matrix and reproducible evidence for this phase are recorded in [`docs/architecture/pr0-verification.md`](./docs/architecture/pr0-verification.md).

## Local Safety

This repository is developed on a host with existing services. Do not start the application or its Compose stack locally. Use local lint, typecheck, and unit tests only; GitHub Actions owns build and runtime verification.

For deployment on another host, create the bind-mounted data directory as the runtime user and pass that user's numeric IDs when they differ from `1000:1000`:

```bash
mkdir -p data
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

## License

Imagine Media Studio is licensed under the [MIT License](./LICENSE). Reviewed third-party projects and future attribution requirements are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
