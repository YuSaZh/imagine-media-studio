# Imagine Media Studio Agent Rules

`PLAN.MD` is the authoritative product and delivery plan. Read the relevant PR section before changing code.

## Phase Gates

- Implement only the currently approved PR phase.
- PR 0 is infrastructure only: use a neutral placeholder UI, Mock Provider, SQLite, an in-process JobRunner, and one Docker service.
- Do not implement real providers or PR 1 UI during PR 0.
- Grok Imagine is the only UI/UX reference for PR 1 and later UI work.
- Never reuse the donor projects' App Shell, pages, Composer, Gallery, Viewer, CSS tokens, responsive layout, or page-level store.

## Runtime Boundaries

- Keep one Node.js application process, one SQLite database, one port, and one `/data` volume.
- Do not add PostgreSQL, Redis, MinIO, Nginx, a worker container, or another business service.
- Never expose API keys to the browser, logs, PWA cache, or exported configuration.

## Host Safety

- Do not stop, restart, rename, inspect secrets from, or otherwise alter existing host services and containers.
- Do not run this project's application, Compose stack, E2E server, or Docker build on the development host.
- Run Playwright, application-server, Compose, and Docker smoke tasks in GitHub Actions.
- Local dependency installation, lint, typecheck, unit tests, and production builds are allowed when they do not start or alter a running service.

## Delivery

- Use `YuSaZh <aimescc@icloud.com>` for commits.
- Keep dependency versions exact and update them in dedicated changes.
- Record third-party review or reuse in `docs/third-party/reuse-audit.md` before copying code.
- The primary agent owns commits, pushes, releases, and cross-area integration. Sub-agents must not commit or push.
- The user grants the primary agent standing authorization to stage accepted project changes, create commits, and push them directly to `origin/main` after each verified milestone. Do not ask the user to reconfirm these Git operations.
- If the execution sandbox requires elevated Git access, reuse the narrow approved `git add`, `git commit`, and `git push` rules without pausing for another product-level authorization question.
