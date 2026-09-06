# Imagine Media Studio Agent Guide

These are shared repository instructions for coding agents and maintainers.
They apply throughout this repository; directory guides add scoped requirements.
Follow the current task and higher-priority instructions. If a conflict affects
the requested behavior or a security boundary, explain it before proceeding.

## Start Here

1. Inspect the current branch and worktree changes. Preserve work from other
   contributors; do not reset, overwrite, or stage unrelated changes.
2. Read this file, [CONTRIBUTING.md](./CONTRIBUTING.md), and the directory guides
   for every area you will edit. Before entering another area, read its guide.
   Do not assume the agent tool automatically loads every nested guide.
3. Read the relevant current specification through [docs/README.md](./docs/README.md).
   Early PR records are historical evidence, not instructions to resume a phase.
4. Identify the smallest coherent change and its verification requirements.
   Coordinate shared files when contributors work concurrently.
5. Report the resulting behavior, checks actually run, and remaining limitations.

## Directory Rules

| Area | Read before editing |
| --- | --- |
| Frontend, UI, browser state, PWA | [apps/web/AGENTS.md](./apps/web/AGENTS.md) |
| Server, database, jobs, media, Providers | [apps/server/AGENTS.md](./apps/server/AGENTS.md) |
| Shared schemas, Provider contracts, testkit | [packages/AGENTS.md](./packages/AGENTS.md) |
| Browser tests, fixtures, screenshot baselines | [e2e/AGENTS.md](./e2e/AGENTS.md) |
| CI, test images, releases | [.github/AGENTS.md](./.github/AGENTS.md) |

For changes spanning areas, apply all relevant guides. Root configuration,
Docker files, and dependency changes also follow the affected runtime guides.
Directory guides must not weaken the runtime and secret boundaries below.

## Product and Runtime Boundaries

- Build a lightweight self-hosted image/video workspace using user-provided
  external APIs. Do not introduce model inference, GPU scheduling, billing,
  or a general-purpose API gateway as incidental work.
- Keep one Node.js application process, one SQLite database, one application
  port, one business container, and one `/data` volume. Jobs run in-process.
  Bounded media subprocesses and trusted adapter worker threads are allowed.
- Do not add PostgreSQL, Redis, MinIO, Nginx, a worker container, or another
  business service. An operator's existing reverse proxy is outside this topology.
- Keep Provider credentials encrypted on the server. Never expose keys or
  secret headers through browser DTOs, logs, previews, PWA caches, or exports.
- Preserve account ownership checks and project/model settings isolation.
- Model capabilities and stored parameter policies govern generation controls
  and server validation. Keep vendor wire protocols out of React components.
- Grok Imagine is the visual and interaction reference, subject to this project's
  approved UI specifications. Do not copy donor App Shells, pages, Composer,
  Gallery, Viewer, CSS tokens, responsive layouts, or page-level stores.

## Implementation and Verification

- Use the Node and exact pnpm/dependency versions declared in `package.json`
  and `pnpm-workspace.yaml`. Keep dependency upgrades in dedicated changes.
- Follow existing module boundaries, shared schemas, helpers, and test patterns.
  Avoid unrelated refactors, generated-file churn, or dependencies for small tasks.
- Use the [verification matrix](./CONTRIBUTING.md#verification) for local checks.
  Run relevant available gates before pushing; GitHub Actions remains the remote
  acceptance gate. Do not equate fixtures with live Provider acceptance.
- Keep Chinese and English READMEs consistent when changing public behavior,
  deployment commands, configuration, or documentation links.
- Update current specifications with behavior changes. Keep dated test results
  and historical records explicitly tied to their original scope.
- Before copying or adapting third-party code, record the revision, license,
  files, local targets, and tests in [reuse-audit.md](./docs/third-party/reuse-audit.md).
  Preserve required notices in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Host and Collaboration Safety

- Do not stop, restart, rename, extract secrets from, or alter pre-existing host
  services or containers. Read-only diagnostics must stay within the task scope
  and exclude credentials and private payloads from output.
- Runtime tests use task-owned temporary data, a non-conflicting port, and a
  unique Compose/resource namespace. Create, restart, and remove only those
  resources. Never aim destructive fixtures at an existing deployment.
- Track temporary processes/resources and clean them up after validation, unless
  the user requests an ongoing preview. Avoid global prune or cleanup commands.
- Use the contributor's configured Git identity; do not hardcode another person's
  name/email or change global Git configuration.
- Contributions normally use a branch and PR. Existing explicit maintainer
  authorization for commits or direct pushes remains valid within its scope;
  do not ask for the same authorization again. This file grants no blanket
  permission to publish images, deploy, or push for every contributor.
- Stage only reviewed task changes. Never force-push shared history without an
  explicit request. When agents are delegated work, the integrating agent owns
  commits, pushes, and cross-area integration unless the maintainer says otherwise.
- Keep personal tool settings, machine paths, SSH aliases, and credentials out
  of shared instructions. A new checkout must not depend on a maintainer's memory.
