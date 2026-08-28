# PR8 Release Pipeline

Status: **v0.1.0 release pipeline and post-release verification passed.**

This milestone adds a release-only GitHub Actions workflow at
`.github/workflows/release.yml`. It is separate from the normal CI workflow and
does not change the application runtime, database, media, archive, or migration
code.

## Trigger and version gate

The workflow listens to the numeric `v[0-9]+.[0-9]+.[0-9]+` tag shape using
GitHub Actions' tag glob syntax. The first publish step is an authoritative
strict semantic-version gate in `.github/scripts/release-guard.mjs`: the ref
must be a stable `vX.Y.Z` tag; the root, server-app, web-app, and server
`APP_VERSION` values must all be stable and identical; and the tag must match
that version exactly. Pre-release tags, leading-zero versions, branch refs,
cross-manifest drift, app-info drift, and mismatched tags fail before registry
login or image build.

The root, server-app, web-app, and app-info versions are `0.1.0`; private
internal library workspaces retain their independent `0.0.0` placeholders. Tag
`v0.1.0` passed this gate and resolves to commit `967b350`. The resulting GitHub
Release and GHCR image are published.

## Candidate publish job

The publish job has only `contents: read`, `packages: write`, `id-token: write`,
`attestations: write`, and `artifact-metadata: write`. It uses the requested
current action majors: checkout v6, QEMU v4, Buildx v4, login v4, metadata v6,
build-push v7, and attest v4.

Every action reference is pinned to an immutable commit and retains a reviewable
major-version comment: checkout v6
(`d23441a48e516b6c34aea4fa41551a30e30af803`), setup-node v5
(`a0853c24544627f65ddf259abe73b1d18a591444`), setup-qemu v4
(`96fe6ef7f33517b61c61be40b68a1882f3264fb8`), setup-buildx v4
(`37fe631027851001ddb9b187196cc803df7f5f0e`), login v4
(`dbcb813823bdd20940b903addbd779551569679f`), metadata v6
(`dc802804100637a589fabce1cb79ff13a1411302`), build-push v7
(`53b7df96c91f9c12dcc8a07bcb9ccacbed38856a`), and attest v4
(`1e69f48acb82d1966a394da916b4c1698aa569d6`).

`docker/metadata-action` produces only a run-unique candidate tag containing
the full commit SHA, run id, and attempt. It does not produce `0.1.0`, `0.1`,
`latest`, or the consumer-facing `sha-<commit>` tag. Buildx publishes
`linux/amd64` and `linux/arm64`, applies release-version OCI labels, enables
BuildKit SBOM and maximum provenance output, and returns the immutable manifest
digest. The workflow records that digest in the job output and run summary.
`actions/attest` creates a Sigstore-backed, registry-stored GitHub artifact
attestation for the same image name and digest. A failed smoke can leave only
the run-unique candidate and digest; it cannot promote a stable or mutable
consumer tag.

The Dockerfile runtime stage also carries default OCI title, description,
source, license, version, revision, and creation labels. Release build args
replace the version, revision, and creation values; metadata-action remains the
source of the final release label set.

## Digest smoke

The dependent smoke job runs on an amd64 `ubuntu-24.04` runner and receives the
published manifest digest, never a mutable tag. It logs in with package-read
permission, pulls the exact GHCR digest, and generates a task-owned JSON
Compose file with one `imagine-media` service, a task-owned temporary `/data`
directory, a unique Compose project name, and an allocated loopback port.

Before reusing `.github/scripts/docker-smoke.sh`,
`.github/scripts/release-smoke.sh` independently checks:

- the Compose service is exactly the expected image digest and mounts `/data`;
- `/internal/health` reports both application and database health;
- a read-only SQLite connection passes `integrity_check` and
  `foreign_key_check`;
- a marker written to the task-owned data volume survives a container restart,
  followed by another SQLite integrity check.

The existing smoke then exercises the broader API, Mock Provider, media,
backup, adapter, and persistence checks against that same digest. Cleanup uses
only the generated Compose project and the task-owned temporary directory; it
does not target pre-existing containers, volumes, networks, ports, or data.

## Promotion and GitHub Release

The `promote` job depends on successful `publish` and `smoke` results and holds
only `packages: write`. It copies the already-tested image index by digest with
`docker buildx imagetools create`, attaches `0.1.0`, `0.1`, `latest`, and the
full `sha-<commit>` tag, and verifies the returned descriptor digest. No image
is rebuilt during promotion. The workflow uses one non-cancelling global
release concurrency group so two stable-tag promotions do not run together.

The final `github-release` job depends on successful promotion and holds only
`contents: write`. Its pinned checkout and Node actions read the matching
version section from `CHANGELOG.md` and append the tested image digest and
release guide link to a fixed task-owned `0600` notes file. The publisher first
invokes `gh release create` with `--verify-tag` and `--notes-file`. If creation
returns an ambiguous failure or the Release already exists, it never edits or
upserts it: two structured reads must prove exact tag, title, non-draft,
non-prerelease, body, current digest, and Latest-release identity before the
step can succeed. A failed read or mismatch fails closed. An `always()` cleanup
step validates the fixed `RUNNER_TEMP` path and removes only that notes file.
The GitHub token remains an environment value and is not interpolated into a
command or release note. The Release is therefore created or verified only
after the exact digest has passed smoke and its stable tags have been attached.

## Evidence boundary

Local evidence for this milestone includes `pnpm test`, which runs the normal
unit suite and the structured workflow/guard test, plus shell syntax, lint,
Docker Compose configuration parsing, and Dockerfile/build metadata checks.
The generated release Compose can be checked without a daemon or image pull
with
`RELEASE_SMOKE_DRY_RUN=true RELEASE_IMAGE=ghcr.io/yusazh/imagine-media-studio@sha256:<64-hex> RELEASE_DIGEST=sha256:<64-hex> bash .github/scripts/release-smoke.sh`;
the dry-run flag is never enabled by the release workflow. The structured test
also proves that consumer tags and GitHub Release creation occur only in jobs
downstream of successful digest smoke, checks all four release-facing version
sources, and covers first creation, identical-release recovery, mismatches,
failed reads, notes cleanup, and per-platform SPDX/SLSA validation.

## Remote release evidence

[Release run 33215005527](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33215005527)
passed all four jobs for tag commit `967b350`: multi-platform candidate publish,
exact-digest amd64 smoke, stable-tag promotion, and GitHub Release publication.
Tags `0.1.0`, `0.1`, `latest`, and
`sha-967b350ff76f15b54e4de0db91d092b778dceac8` resolve to
`sha256:025b56e7cbe198bea60954068b135fa71bcb9fa9e029aa04d44cf30c3bc37018`.
The index contains `linux/amd64` and `linux/arm64` images plus their BuildKit
attestation manifests, and the GitHub artifact attestation verifies against the
repository.

The [v0.1.0 GitHub Release](https://github.com/YuSaZh/imagine-media-studio/releases/tag/v0.1.0)
is the non-draft, non-prerelease Latest release. Its corrected verifier asset is
3,681 bytes with SHA-256
`526c6799d3b4bb1e9098e9068bd66521d8bdba06d8df01381dd6dc10c371ee67`
and matches commit `4dc4432`. [Fix CI run 33216883872](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33216883872)
passed all 17 jobs, and the corrected helper validates the published digest's
real amd64/arm64 SPDX and SLSA v1 output.

This pipeline does not close the external-platform PWA or private Grok visual
reference items recorded in `Hold.md`. The v0.1.0 Release presents them as known
limitations and does not represent them as completed.

Official action and attestation references:

- <https://github.com/actions/checkout>
- <https://github.com/docker/setup-qemu-action>
- <https://github.com/docker/setup-buildx-action>
- <https://github.com/docker/login-action>
- <https://github.com/docker/metadata-action>
- <https://github.com/docker/build-push-action>
- <https://github.com/actions/attest>
- <https://cli.github.com/manual/gh_release_create>
- <https://cli.github.com/manual/gh_release_view>
- <https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/>
- <https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/>
