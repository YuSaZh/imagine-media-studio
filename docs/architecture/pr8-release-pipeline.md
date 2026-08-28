# PR8 Release Pipeline

This milestone adds a release-only GitHub Actions workflow at
`.github/workflows/release.yml`. It is separate from the normal CI workflow and
does not change the application runtime, database, media, archive, or migration
code.

## Trigger and version gate

The workflow listens to the numeric `v[0-9]+.[0-9]+.[0-9]+` tag shape using
GitHub Actions' tag glob syntax. The first publish step is an authoritative
strict semantic-version gate in `.github/scripts/release-guard.mjs`: the ref
must be a stable `vX.Y.Z` tag, the root `package.json` version must also be
stable, and the two values must match exactly. Pre-release tags, leading-zero
versions, branch refs, and mismatched tags fail before registry login or image
build.

The current root version is `0.0.0`. Therefore this checkout cannot publish
`v0.1.0`; a release requires a separate version bump and matching tag. No tag,
GitHub Release, GHCR push, or remote release run was created for this
milestone.

## Publish job

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

`docker/metadata-action` produces the stable semver, `major.minor`, `latest`,
and long commit SHA tags for
`ghcr.io/yusazh/imagine-media-studio`. Buildx publishes `linux/amd64` and
`linux/arm64`, applies the metadata OCI labels, enables BuildKit SBOM and
maximum provenance output, and returns the immutable manifest digest. The
workflow records that digest in the job output and run summary. `actions/attest`
then creates a registry-backed digest attestation for the same image name and
digest.

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

## Evidence boundary

Local evidence for this milestone includes `pnpm test`, which runs the normal
unit suite and the structured workflow/guard test, plus shell syntax, lint,
Docker Compose configuration parsing, and Dockerfile/build metadata checks.
The generated release Compose can be
checked without a daemon or image pull with
`RELEASE_SMOKE_DRY_RUN=true RELEASE_IMAGE=ghcr.io/yusazh/imagine-media-studio@sha256:<64-hex> RELEASE_DIGEST=sha256:<64-hex> bash .github/scripts/release-smoke.sh`;
the dry-run flag is never enabled by the release workflow. The digest smoke is
designed for the remote release job but was not run here because no tag was
created and no image was pushed.

This pipeline does not close the external-platform PWA or private Grok visual
reference items recorded in `Hold.md`. Those remain release evidence gates and
must not be represented as completed by this workflow design.

Official action and attestation references:

- <https://github.com/actions/checkout>
- <https://github.com/docker/setup-qemu-action>
- <https://github.com/docker/setup-buildx-action>
- <https://github.com/docker/login-action>
- <https://github.com/docker/metadata-action>
- <https://github.com/docker/build-push-action>
- <https://github.com/actions/attest>
