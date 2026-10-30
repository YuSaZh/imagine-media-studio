# Pinned CI toolchain and build caches

The `ci`, `ci:quality`, `ci:browser` and `ci:docker` package scripts use
`../scripts/ci-toolchain.mjs`. Both local Linux runs and GitHub jobs execute
the same toolchain. A local Unix Docker socket is required. Native focused
development commands remain available outside this container.

## Toolchain identity and reuse

`toolchain.json` pins base images by digest, pnpm, Playwright and Noto package
versions. The image contains Chromium, FFmpeg, compiler tools and Docker
CLI/Compose; it contains no application source, dependency tree or credentials.
Its cache key hashes the configuration, Dockerfile and target architecture.
Changes to pnpm or Playwright must update the matching pin; mismatches fail.

The launcher verifies the image fingerprint, loads a matching archive if needed,
or builds the image when neither exists. A mismatching image/archive fails
closed. `node .github/scripts/ci-toolchain.mjs prepare` creates an atomic gzip
archive in ignored `.ci-cache/`. `key` prints the exact cache identity.

GitHub's toolchain job restores that archive using an exact `actions/cache` key,
then shares it with the current run's jobs through an artifact. An initial cache
miss still builds automatically, including for fork PRs; it needs no publishing
token or pre-existing GHCR package. Apt/browser setup happens once on that miss.
The archive is large, so transfer/load time remains part of CI and must be
measured separately from test execution. A new toolchain key has a cold start.

## Runtime isolation and reports

Each invocation installs the frozen workspace into task-owned Docker volumes
masking every workspace `node_modules`; host dependencies remain separate.
The ignored `.ci-cache/pnpm-store` is reusable. A temporary root is mounted at
the same absolute path on the host/container so Docker smoke can bind its own
data. The launcher uses the host UID/GID, host networking and Docker socket;
Docker access has the same administrator trust boundary as native source smoke.
Only CI-specific environment values are forwarded, never host Provider or
publishing credentials. Do not run untrusted changes against sensitive hosts.

Each browser project has one worker, its own port and fresh database. The local
default is capped at four projects, CPU count and available host memory divided
by 3 GiB. `CI_BROWSER_CONCURRENCY=1..8` changes scheduling only; it cannot filter
the full eight-project gate. GitHub's matrix allows eight concurrent jobs.
Existing single retry, snapshot policy and separate flaky reporting remain.

The shared `../browser-coverage.json` policy gives 1440×900 and 390×844 every
scenario. The other six projects exclude only reviewed `@workflow` cases;
geometry, responsive layout, accessibility, animation, scrolling, touch and
visual baseline tests retain all applicable viewports. Mixed cases keep their
original assertions and viewport coverage. New untagged cases run on all eight.
There is no environment switch to remove a required project from full CI.
The release contract checks real Playwright collection and writes the exact
per-project inventory to `ci-results/browser-coverage.json`. Policy omissions
are planned duplicate removal, separate from conditional runtime skips.

Containers, dependency volumes and temporary data are removed on completion or
failure. The reusable toolchain image/archive/store intentionally remain.
`ci-results/*/summary.json` records source hash, toolchain identity, project
ports, statuses and stage durations. `ci-results/toolchain-runs/*.json` also
records preparation and total invocation time. Reports distinguish a partial
scope from full CI; a failed run is never release evidence.

## Application image caches

The application Dockerfile downloads dependencies from the lockfile before
copying source. It compiles JS/CSS once on `BUILDPLATFORM`, then installs native
production modules independently for each `TARGETARCH`. No host dependency tree
is copied into runtime images. SQLite and other native modules must match the
target architecture; both architectures still need artifact verification.
The production fetch layer retains its pnpm store in the exported layer because
mutable cache mounts are not part of a registry cache. Installation/deployment
then runs offline with networking disabled, including after a cache import.
Deployment uses pnpm's shared-lockfile path with a command-local
`injectWorkspacePackages=true` option. It converts existing workspace links
into self-contained deployment packages and freezes the resulting lockfile;
the repository's workspace configuration and dependency lockfile stay intact.
The legacy deploy path is avoided because it re-resolves the whole workspace.

Stable publication imports/exports a BuildKit registry cache at
`${IMAGE}-buildcache:release` with `mode=max`. This separate package contains
build layers, not a runnable release. Only the existing authorized stable
publish job writes it. Test-image publication may import it and also retains
its own GitHub Actions cache. The cache requires the publishing token to create
and write the derivative package; denied cache writes fail the build rather
than silently claiming reuse. Local CI never publishes this cache.

Cache hits do not replace exact-commit main CI, candidate digest smoke,
multi-architecture output checks, signatures, SBOM or provenance. An expired or
absent cache is a performance issue, not permission to skip a gate. Keep cache
and artifact timings distinct when comparing cold and warm runs.
