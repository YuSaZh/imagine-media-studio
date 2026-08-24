# PR 0 Verification

Status: **passed**

PR 0 was verified at commit `55f4d2bc5f1a7a51ce4a24d1597b8c84062e5e8e` by [GitHub Actions run 32770343331](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32770343331).

## Acceptance Matrix

| PLAN.MD requirement | Result | Evidence |
|---|---|---|
| Clean pnpm workspace with the five planned packages | Pass | `pnpm-workspace.yaml` contains `apps/*` and `packages/*`; the expected web, server, shared, provider-contract, and testkit workspaces are present. |
| React/Vite placeholder and Fastify app server | Pass | The neutral PR 0 App Shell is served by the same Fastify application that exposes `/internal/**`. |
| One business container, one port, one `/data` volume | Pass | Compose resolves to one `imagine-media` service. The remote smoke uses one isolated project, a temporary data directory, and port `18080`. |
| SQLite at `/data/app.db` with committed migrations | Pass | Docker smoke verifies the database and `schema_migrations` entry for `0000_pr0.sql`. Unit tests verify required PRAGMAs and idempotent migration startup. |
| In-process JobRunner and deterministic Mock Provider | Pass | The server owns one JobRunner. The Mock test asserts that `fetch` is unused, the adapter contains no network primitive, and completion is deterministic. |
| Mock Job persists to SQLite and creates media | Pass | Unit and Docker smoke tests verify a completed job, one asset row, a non-empty PNG, matching file path, size, MIME type, and SHA-256. |
| Completed records survive restart | Pass | Docker smoke restarts the service and retrieves the original completed job. |
| Queued Mock Job resumes after restart | Pass | A unit test reopens a database containing a queued job. Docker smoke also inserts a queued fixture before restart and waits for it to complete afterward. |
| Installable minimal PWA | Pass | The manifest declares 192/512 and maskable icons. Two Chromium projects request every icon and verify standalone display, screenshots, an active Service Worker, and an empty `Page.getInstallabilityErrors` result. |
| Offline App Shell | Pass | Each Playwright project waits for Service Worker control, disables networking, reloads, and verifies the App Shell. |
| Desktop and mobile viewport coverage | Pass | Playwright covers fixed `1280x720` and `390x844` viewports and uploads both screenshots. |
| Design reference process and templates | Pass | `docs/design-spec` contains the required templates; `.design-reference` tracks only ignore rules and public handling instructions. |
| Third-party review before reuse | Pass | `docs/third-party/reuse-audit.md` records pinned SHAs, licenses, allowed review scope, risks, and test gates. PR 0 copied no upstream code or UI. |
| Neutral UI and phase boundary | Pass | No real Provider, Composer, Gallery, Viewer, donor App Shell, donor CSS tokens, or PR 1 page/store implementation is present. |
| Required Git identity and staged delivery | Pass | All PR 0 commits use `YuSaZh <aimescc@icloud.com>` and were pushed to `main`. |

## Verification Split

Local checks were limited to the host-safe operations allowed by `AGENTS.md`:

```text
pnpm lint
pnpm typecheck
pnpm test
bash -n .github/scripts/docker-smoke.sh
git diff --check
```

The final local result was 6 test files and 15 passing tests. No local application server, Compose stack, Docker build, Playwright server, or project build was started.

GitHub Actions ran the runtime-dependent checks on `ubuntu-24.04`:

| Job | Result |
|---|---|
| Lint, typecheck, unit, build | Pass |
| Playwright PWA smoke | Pass |
| Single-container persistence smoke | Pass |

Session-local safety checks found port `3030` unused and observed 23 existing running containers before and after PR 0. These host observations are recorded in ignored local planning logs, not reproduced by Actions. No host runtime command for this project was executed.

## Visual Evidence

- `apps/web/public/screenshots/pwa-desktop-1280x720.png`
- `apps/web/public/screenshots/pwa-mobile-390x844.png`

These images document the neutral PR 0 App Shell. They are not a PR 1 Grok Imagine visual baseline.

## Deferred By Design

- The Grok Imagine-referenced UI shell begins only after a private reference package is frozen for PR 1.
- Real image/video providers, secret encryption, authentication, and remote media downloading are later phases.
- Full PWA installation guidance, mobile keyboard refinement, gallery/task restoration, and application-level runtime caching remain assigned to later PRs in `PLAN.MD`.
- Branch protection and full commit-SHA pinning for Actions are repository hardening work, not PR 0 runtime requirements.
