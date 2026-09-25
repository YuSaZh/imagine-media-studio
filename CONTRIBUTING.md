# Contributing to Imagine Media Studio

[Chinese README](./README.md) | [English README](./README_EN.md) | [日本語 README](./README_JA.md) |
[Agent rules](./AGENTS.md) | [Documentation](./docs/README.md)

This guide applies to human contributions and work assisted by coding agents.
Repository rules are versioned with the code so a new contributor can work
without a previous maintainer's chat history or machine configuration.

## Getting Started

Use Node.js 24 and the exact pnpm version in [package.json](./package.json).
FFmpeg/ffprobe must be available for media processing. Browser tests also require
Chromium and the fonts/system libraries used in CI for reproducible screenshots.

```bash
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

After building, start a temporary Mock-backed session from the repository root.
Confirm that port `13030` is unused; the built server serves the UI and API on
that one port. This example uses Bash and `openssl`:

```bash
IMAGINE_DEV_DATA="$(mktemp -d /tmp/imagine-media-dev.XXXXXX)"
APP_PORT=13030 DATA_DIR="$IMAGINE_DEV_DATA" \
  WEB_DIST_DIR="$PWD/apps/web/dist" \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=local-preview-only \
  APP_SECRET="$(openssl rand -hex 32)" MOCK_PROVIDER_ENABLED=true \
  pnpm --filter @imagine/server start
```

Open `http://localhost:13030` and sign in with `admin` / `local-preview-only`.
Mock produces test outputs without calling a real model. Stop the process with
Ctrl+C when finished, and remove only its temporary data directory. For a
persistent deployment, use the [Docker quick start](./README_EN.md#quick-start).

Never commit `.env`, credentials, application data, browser authentication state,
private screenshots, or local tool settings. Examples use placeholders or
explicitly disposable test credentials.

## Working With Agents

- Open the repository as the project and read [AGENTS.md](./AGENTS.md). Its table
  routes tasks to the relevant directory guides and current specifications.
- Before editing a module, make sure its directory guide has been read. Loading
  rules from a parent directory does not prove all descendants were loaded.
- Agent discovery differs by tool. For Codex, see the official
  [instruction discovery guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
  Ask the agent to identify the applicable repository guides before its first edit.
- For a tool that needs a different entry filename, configure a small entry that
  instructs it to read the root guide and applicable directory guides. Keep the
  actual rules in AGENTS files; do not maintain competing copies for each tool.
- Project rules must not depend on personal skills, absolute home paths, SSH
  aliases, a particular agent model, or a previous session's private memory.

An explicit starting instruction for tools without automatic discovery is:

> Read AGENTS.md and CONTRIBUTING.md at the repository root. Before editing any
> directory, read its applicable AGENTS.md files and the referenced specification.
> Preserve existing worktree changes and report the checks you actually run.

Instruction files guide work; they do not grant credentials or prove compliance.
Review and CI check the resulting change.

## Changes and Collaboration

1. Check the current branch and worktree. Use a topic branch and a separate
   checkout/worktree when concurrent work could interfere.
2. State the intended behavior and affected areas. Coordinate ownership of shared
   schemas, root configuration, and other files touched by multiple contributors.
3. Implement a focused change using existing contracts and helpers. Update current
   design/architecture guidance when changing behavior or a lasting convention.
4. Run applicable local checks below and review the full diff. Stage only changes
   belonging to the task, with the contributor's own configured Git identity.
5. Open a PR describing the problem, resulting behavior, verification, and material
   limits. Explain intended screenshot changes and compatibility/migration effects.

Use descriptive commit subjects and keep dependency upgrades separate from feature
work. Maintainer-authorized direct commits/pushes are valid within their stated
scope; do not infer blanket publishing or deployment permission from this guide.
Existing explicit authorization does not need repeated confirmation.

## Verification

Use focused checks during development. Before publishing a release, run the complete local acceptance entry:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm run ci
```

Install FFmpeg and Noto core/CJK fonts as in the GitHub workflow. Docker with Compose and a running daemon are required. The runner creates isolated ports, temporary databases and Compose resources; it never targets the persistent preview. Reports are retained under ignored `ci-results/`. A nonzero exit or incomplete run does not qualify as full CI.

### Local and GitHub CI parity

- `pnpm run ci` runs lint, types, all unit/integration/release tests, production build, the unfiltered eight-viewport browser suite and isolated source Docker smoke.
- `pnpm run ci:quality`, `pnpm run ci:browser [workspace-WIDTHxHEIGHT]` and `pnpm run ci:docker` are explicit partial entries. GitHub calls these same scripts. The browser entry builds first, sets `CI=true`, disables snapshot updates and gives each viewport a fresh server/database. Both environments use `.github/ci-projects.json` as the matrix source.
- Match the declared Node/pnpm versions, frozen dependencies, Chromium, fonts and flags. OS/container differences remain possible; report them. Workflow-defined test skips are not missing gates and must be reported separately. Mock fixtures do not prove live Provider acceptance.
- A release requires complete local evidence. Reuse passed evidence only for unchanged source inputs, assertions and environment. A notes-only follow-up needs release validation; changed tests or scripts require their affected gates again. Never label focused tests as full CI or weaken assertions to pass.
- GitHub main CI must independently accept the exact release commit. The tag workflow waits for the latest main-push run, validates all required jobs and never starts duplicate source CI. Failed, cancelled, skipped or absent jobs block publication. Existing success for another commit or an older attempt does not qualify.
- The actual published candidate still receives digest smoke before promotion. It is a different artifact from the local source image. Publication and development deployment are separate actions.

### Checks during development

| Change | Local verification |
| --- | --- |
| Documentation/instructions only | `git diff --check`; inspect Markdown rendering, relative links/anchors, referenced paths, and language parity; validate changed shell/YAML/JSON examples without executing deployment |
| Frontend behavior or UI | Lint, workspace typecheck, focused unit tests, production build; relevant desktop and mobile browser flows/screenshots |
| Server routes/Providers/jobs | Lint, typecheck, focused unit/contract tests, build; relevant authorization, failure, cancellation, and recovery cases |
| Shared contracts | Workspace lint, typecheck, tests, build; affected browser/server consumers and persistence compatibility |
| Database/media/runtime/Docker | Quality checks plus relevant migration, archive, restart, persistence, and isolated Docker smoke |
| CI or release logic | Workflow YAML validation, `pnpm test:release`, syntax checks for changed shell scripts, and affected isolated runtime smoke |

The partial quality gate is:

```bash
pnpm run ci:quality
```

It runs lint, typecheck, unit/release tests, and production builds. Focused tests
can be selected with `pnpm exec vitest run <test-path>`. Focused checks do not
replace broader checks when a shared boundary is affected.

Browser checks require a fresh build and a locally reserved unused port. Replace
the example port if occupied:

```bash
pnpm exec playwright install chromium
E2E_PORT=13031 pnpm test:e2e --project=workspace-1440x900 --project=workspace-390x844 --update-snapshots=none
pnpm run ci:browser
```

The first browser command selects two representative projects for development;
the second builds and runs all eight projects with isolated data and automatically allocated ports. Use `CI=true` for acceptance parity.
During development, select scenarios and viewports affected by the change;
the complete unfiltered eight-viewport run is required locally before release and repeated by GitHub main CI.
Read [e2e/AGENTS.md](./e2e/AGENTS.md) for baseline and cleanup rules.

For isolated Docker smoke, run `pnpm run ci:docker`. All data,
ports, Compose projects, containers, and cleanup targets must belong to that run.
Do not run an unscoped `docker compose up/down` against an existing deployment.

If a gate cannot run, report the exact blocker and the checks completed. Use
[Hold.md](./Hold.md) for persistent unverified evidence or product limitations.
Mock/fixture tests do not prove live Provider compatibility, and browser emulation
does not prove physical-device PWA installation or keyboard behavior.

## Documentation and Releases

- Keep the default Chinese [README](./README.md) and [English version](./README_EN.md)
  aligned for user-facing changes. Keep one canonical set of Agent rules.
- Use [docs/README.md](./docs/README.md) to distinguish current specifications from
  historical PR evidence. Do not turn old test counts or deferred features into
  current acceptance claims.
- Document third-party review/reuse and preserve license notices before code is
  copied or adapted. See [reuse-audit.md](./docs/third-party/reuse-audit.md).
- CI success, Test Image publication, stable release, and deployment are separate
  events. Use [RELEASE.md](./RELEASE.md) and [.github/AGENTS.md](./.github/AGENTS.md)
  for their current boundaries. A push to `main` alone does not update `test`.
- A stable tag reuses successful main CI for its exact commit; it does not rerun
  source checks. Prefer tagging after main CI passes; early tags wait for that
  existing run. Digest smoke validates the release candidate before promotion.
- Changes to shared rules should describe their reason and update affected links
  in the same PR. Contributors must not silently remove a guard to pass a check.
