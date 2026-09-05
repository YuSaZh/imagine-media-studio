# Imagine Media Studio v0.1.0 Release Guide

Imagine Media Studio `v0.1.0` is published from tag commit `967b350`. The
release workflow passed candidate publication, exact-digest smoke, stable-tag
promotion, and GitHub Release publication. Use the immutable digest recorded in
the [GitHub Release](https://github.com/YuSaZh/imagine-media-studio/releases/tag/v0.1.0),
not a mutable tag, for deployment and verification.

## Deployment boundary

Imagine Media Studio runs as one Node.js container with one SQLite database,
one application port, and one persistent `/data` bind mount. It does not need
PostgreSQL, Redis, MinIO, Nginx, or a separate worker. A host reverse proxy may
be used outside this application boundary.

The container runs as an unprivileged numeric UID/GID. Create the data root as
that user and keep the parent private:

```bash
install -d -m 0700 "$PWD/imagine-state"
install -d -m 0700 "$PWD/imagine-state/live"
```

Keep production configuration in a separately backed-up `0600` environment
file. Generate a new random `APP_SECRET` once and retain it for the lifetime of
the data set:

```text
APP_SECRET=<at-least-32-random-characters>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<initial-administrator-password>
MOCK_PROVIDER_ENABLED=false
```

`APP_SECRET` encrypts Provider credentials stored in SQLite. It is not included
in database backups or full-data archives; losing or changing it makes existing
Provider credentials undecryptable. Initial credentials default to `admin` /
`admin`; `ADMIN_USERNAME` and `ADMIN_PASSWORD` override them only on first start.
After initialization, change credentials in Settings -> Preferences. Docker
administrators can inspect container environment values, so Docker daemon access
remains an administrator trust boundary.

## Install the released image

For `v0.1.0`, take the exact digest from the GitHub Release or release workflow
summary:

```bash
IMAGE='ghcr.io/yusazh/imagine-media-studio@sha256:025b56e7cbe198bea60954068b135fa71bcb9fa9e029aa04d44cf30c3bc37018'
docker pull "$IMAGE"
docker run --detach \
  --name imagine-media \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:3030:3030 \
  --mount type=bind,src="$PWD/imagine-state/live",dst=/data \
  --env-file "$PWD/imagine-media.env" \
  "$IMAGE"
```

No registry login is needed when the GHCR package is public. If repository
policy requires authentication, export a token with only `read:packages` and
pass it on standard input:

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io \
  --username "$GHCR_USERNAME" \
  --password-stdin
```

The token value stays out of process arguments. Never place it in the image
reference, command-line argument, Compose file, environment file committed to
the repository, or logs.

Binding to loopback is the conservative default. Change the published address
only when the network boundary, TLS termination, and administrator credentials are ready.
Source deployments may instead use the repository's `docker-compose.yml`; it
still creates exactly one business service and uses the same `/data` contract.

## Backup and verification

There are two deliberately separate backup boundaries.

The authenticated `POST /internal/maintenance/backups` operation creates an
online, database-only SQLite snapshot at `/data/backups/<id>.db`. It uses the
SQLite Online Backup API and returns only `id`, `size`, `sha256`, and
`createdAt`. It excludes media, Trusted Adapter files, logs, browser data, and
environment secrets, and there is no HTTP download or restore endpoint.
This endpoint returns `403` for ordinary accounts; online database maintenance
requires an authenticated application administrator.

For a complete portable data set, use the offline archive CLI. Stop only this
deployment before `create`; `verify` is read-only and may run while the server
is online:

```bash
docker stop imagine-media
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$PWD/imagine-state/live",dst=/data \
  --entrypoint node "$IMAGE" \
  dist/maintenance/data-archive-cli.js create --data-dir /data
docker start imagine-media

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$PWD/imagine-state/live",dst=/data,readonly \
  --entrypoint node "$IMAGE" \
  dist/maintenance/data-archive-cli.js verify \
  --bundle /data/backups/<id>.bundle
```

The bundle manifest contains a SHA-256 and byte size for the SQLite snapshot,
managed media, and installed Trusted Adapter payloads. It excludes prior
backups, staging data, logs, temporary Provider results, and secrets. Preserve
the whole `<id>.bundle` directory as one unit. The SQLite payload can contain
encrypted Provider credential ciphertext and remains sensitive even though the
external `APP_SECRET` is absent.

## Upgrade and migration

1. Record the running image digest, environment-file backup, and active data
   root. Never rely on `latest` as the rollback record.
2. Create and verify a full-data archive with the currently running image.
3. Stop only the Imagine Media Studio container.
4. Pull and verify the new digest, then recreate the container with the same
   UID/GID, environment file, and `/data` bind mount.
5. Watch startup and `/internal/health`. Startup validates the immutable
   migration manifest and applied checksums, runs pending migrations in order,
   and fails closed on history drift or integrity failure.
6. Exercise authentication, Gallery history, one Mock or approved Provider job,
   and media playback before removing the old container image.

Migrations are forward-only; there are no automatic down migrations. Never edit
an applied SQL migration or its manifest checksum, and do not start an older
image against a database after a newer migration unless compatibility has been
explicitly proven.

## Restore and rollback

Restore always creates an absent target; it never replaces the active `/data`
directory. Stop the deployment and mount the private parent so the archive and
new target are siblings:

```bash
docker stop imagine-media
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$PWD/imagine-state",dst=/recovery \
  --entrypoint node "$IMAGE" \
  dist/maintenance/data-archive-cli.js restore \
  --bundle /recovery/live/backups/<id>.bundle \
  --target /recovery/restored-v0.1.0
```

Inspect the restored tree, recreate the application container with
`imagine-state/restored-v0.1.0` bound to `/data`, and keep the same
`APP_SECRET`. A container-only rollback may reuse the live database only when
the older application is known to support its schema. Otherwise restore the
verified pre-upgrade archive to a new root and switch the bind mount. The CLI
cannot atomically exchange an active Docker bind mount.

## Image, signature, SBOM, and provenance verification

Use the digest, not `0.1.0`, `0.1`, or `latest`, as the verification subject:

Run these commands from a verified `v0.1.0` source checkout. GitHub CLI must be
authenticated with `gh auth login` or a `GH_TOKEN` that can read this repository;
keep that token in the environment, never in an argument or URL. A private GHCR
package also requires the read-only `docker login --password-stdin` flow above.

```bash
IMAGE='ghcr.io/yusazh/imagine-media-studio@sha256:025b56e7cbe198bea60954068b135fa71bcb9fa9e029aa04d44cf30c3bc37018'

gh auth status
docker buildx imagetools inspect "$IMAGE"
gh attestation verify "oci://$IMAGE" \
  --repo YuSaZh/imagine-media-studio

docker buildx imagetools inspect "$IMAGE" \
  --format '{{ json .SBOM }}' > sbom.json
docker buildx imagetools inspect "$IMAGE" \
  --format '{{ json .Provenance }}' > provenance.json
node .github/scripts/verify-release-attestations.mjs \
  --sbom sbom.json \
  --provenance provenance.json
```

The GitHub verification checks the Sigstore-backed artifact attestation for the
published digest and repository identity. It is not a claim that the image is
free of vulnerabilities. BuildKit stores the SPDX SBOM and maximum provenance
as OCI attestations attached to the multi-platform image index. The verification
script rejects empty or `null` output and requires both `linux/amd64` and
`linux/arm64` to contain structured SPDX and SLSA payloads.

The commands above follow GitHub's official
[container attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations#verifying-an-artifact-attestation-for-container-images)
and Docker's official [SBOM](https://docs.docker.com/build/metadata/attestations/sbom/)
and [provenance](https://docs.docker.com/build/metadata/attestations/slsa-provenance/)
inspection guidance.

### v0.1.0 verification erratum

The verification helper committed in the tagged `v0.1.0` source reads the old
SLSA provenance field locations, so it can incorrectly reject valid BuildKit
SLSA v1 output. This helper-only false negative does not affect the published
image, its immutable digest, the digest smoke result, or the registry-backed
attestations.

The corrected `verify-release-attestations.mjs` is attached to the GitHub
Release at this fixed download URL:

```text
https://github.com/YuSaZh/imagine-media-studio/releases/download/v0.1.0/verify-release-attestations.mjs
```

The uploaded asset is 3,681 bytes with SHA-256
`526c6799d3b4bb1e9098e9068bd66521d8bdba06d8df01381dd6dc10c371ee67`
and matches the verifier in commit `4dc4432`. `v0.1.0` users should download it
and replace the final helper invocation above with:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  --output verify-release-attestations.mjs \
  'https://github.com/YuSaZh/imagine-media-studio/releases/download/v0.1.0/verify-release-attestations.mjs'
node ./verify-release-attestations.mjs \
  --sbom sbom.json \
  --provenance provenance.json
```

## Known limitations

The authoritative list is [Hold.md](./Hold.md). In particular, `v0.1.0` must not
be described as having strict authenticated Grok pixel parity, completed native
PWA installation on Windows/macOS/Android/iOS, real mobile keyboard and safe-area
evidence, or live production Provider acceptance. Media cleanup remains
conservative, some retention controls are presentational, large live model
catalogs are limited to one bounded page, and the documented same-UID restore
and lock-cleanup race windows remain outside the atomicity guarantee.

## v0.1.0 completion record

- Annotated tag `v0.1.0` resolves to commit `967b350`.
- [Release run 33215005527](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33215005527)
  passed all four jobs and published digest
  `sha256:025b56e7cbe198bea60954068b135fa71bcb9fa9e029aa04d44cf30c3bc37018`.
- `0.1.0`, `0.1`, `latest`, and the full commit-SHA tag resolve to that digest;
  its index contains both `linux/amd64` and `linux/arm64` images.
- [Fix CI run 33216883872](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33216883872)
  passed all 17 jobs at commit `4dc4432`. The corrected verifier asset matches
  that commit and validates the registry's real SPDX/SLSA output for both
  platforms.

## Future release procedure

1. Require the release-preparation commit and normal CI on `main` to pass.
2. Confirm the root, server, web, and app-info versions match the intended
   stable tag; ensure `CHANGELOG.md` has one non-empty matching version section
   and the working tree is clean.
3. Create and push only the matching stable tag. Do not manually create the
   GitHub Release or pre-push stable GHCR tags.
4. Require the tag workflow to validate the version, publish and attest a
   unique candidate, smoke the exact digest, and only then promote the stable,
   minor, `latest`, and full commit-SHA tags.
5. Verify the Release, GHCR tags, digest attestation, SBOM, provenance, and all
   required platform manifests before announcing availability.
