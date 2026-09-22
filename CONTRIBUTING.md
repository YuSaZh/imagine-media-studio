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

Run affected-area checks locally and reuse passing evidence for unchanged source
and scope. Preparing a release does not require repeating complete local CI.
The final release commit must pass GitHub main CI once. The tag workflow reuses
that exact commit's successful main-push CI, or waits for the existing run;
it does not start another quality/browser/source Docker suite. Required CI jobs
that fail, are cancelled, are skipped or are missing block publication.

### Local and GitHub CI parity

- Use the same commands, scripts, declared Node/pnpm versions, lockfile, browser
  version, fonts and relevant flags when running a check locally. Use `CI=true`
  for browser acceptance. Matching check semantics does not mean running every
  check both locally and remotely for each release.
- Complete CI covers lint, typecheck, all unit/integration and release tests,
  production build, all eight browser viewports and isolated Docker smoke.
  GitHub main CI is the release source acceptance gate. A complete local run is
  optional unless explicitly requested or necessary to investigate a failure.
- Focused checks are the normal local workflow. Reuse successful results when
  neither their source inputs, assertions nor environment changed. A test-only
  fix requires the affected test; a notes-only change requires release/document
  checks, not another full browser/Docker run. If a shared runtime change affects
  multiple areas, broaden checks to those areas. Never hide failures by weakening
  assertions, adding skips or declaring an earlier snapshot tested a later change.
- Record tested commits/source, commands, results, scope and environment. Preserve
  workflow-defined skips and report them separately from missing required jobs.
  Do not rerun a successful suite solely because it is time to push or tag.
- Push the final source to main and allow its existing CI to finish. Prefer tagging
  after success; if the tag arrives earlier, release waits up to 45 minutes for
  the same commit's main CI without dispatching a new run. A failed/cancelled run
  must be corrected or explicitly rerun; missing CI eventually fails closed.
- Release still builds one multi-platform candidate and tests its exact digest.
  This artifact check is distinct from source CI; promotion reuses the verified
  image without rebuilding. Keep local runtime resources isolated and clean up
  task-owned services/data. Publication and deployment remain separate actions.

The current `pnpm run ci` command runs the quality gate only. Browser and Docker
checks still require the separate invocations below; this policy does not claim
that a unified full-CI command has already been implemented.

### Checks during development

| Change | Local verification |
| --- | --- |
| Documentation/instructions only | `git diff --check`; inspect Markdown rendering, relative links/anchors, referenced paths, and language parity; validate changed shell/YAML/JSON examples without executing deployment |
| Frontend behavior or UI | Lint, workspace typecheck, focused unit tests, production build; relevant desktop and mobile browser flows/screenshots |
| Server routes/Providers/jobs | Lint, typecheck, focused unit/contract tests, build; relevant authorization, failure, cancellation, and recovery cases |
| Shared contracts | Workspace lint, typecheck, tests, build; affected browser/server consumers and persistence compatibility |
| Database/media/runtime/Docker | Quality checks plus relevant migration, archive, restart, persistence, and isolated Docker smoke |
| CI or release logic | Workflow YAML validation, `pnpm test:release`, syntax checks for changed shell scripts, and affected isolated runtime smoke |

The standard quality gate is:

```bash
pnpm run ci
```

It runs lint, typecheck, unit/release tests, and production builds. Focused tests
can be selected with `pnpm exec vitest run <test-path>`. Focused checks do not
replace broader checks when a shared boundary is affected.

Browser checks require a fresh build and a locally reserved unused port. Replace
the example port if occupied:

```bash
pnpm exec playwright install chromium
E2E_PORT=13031 pnpm test:e2e --project=workspace-1440x900 --project=workspace-390x844 --update-snapshots=none
CI=true E2E_PORT=13031 pnpm test:e2e --update-snapshots=none
```

The first browser command selects two representative projects for development;
the second runs the full suite in all eight. Use `CI=true` for acceptance parity.
During development, select scenarios and viewports affected by the change;
the complete unfiltered eight-viewport run is supplied by GitHub main CI for a release.
Read [e2e/AGENTS.md](./e2e/AGENTS.md) for baseline and cleanup rules.

For Docker smoke, follow the isolated resource setup in
[ci.yml](./.github/workflows/ci.yml) before running its smoke script. All data,
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
