# PR8 Data Archive Core

Status: **Offline archive, target-only restore, restored-server startup, and GitHub Actions acceptance passed.**

This milestone defines an offline, versioned data bundle and target-only
restore flow for Imagine Media Studio. It is a directory bundle that can be
copied as a unit; it is not a compressed tar archive.

## Bundle layout

```text
<id>.bundle/
  manifest.json
  database/app.db
  media/originals/...
  media/thumbnails/...
  media/posters/...
  media/uploads/...
  media/masks/...
  adapters/<adapter-id>/manifest.json
  adapters/<adapter-id>/adapter.mjs
```

`manifest.json` has a fixed format/version, an ISO timestamp, a sorted unique
payload list, and a SHA-256 plus byte size for every payload. The manifest is
strictly parsed and does not contain the host data path, credentials, or
runtime configuration.

## Source and exclusions

The live SQLite file is copied only through better-sqlite3 Online Backup API;
the source `app.db`, WAL, and SHM files are never copied directly. The staged
database is opened read-only with foreign keys enabled and must pass bounded
`integrity_check` and `foreign_key_check` before publication.

The payload allowlist contains the five managed media trees and installed
trusted adapter files. The entire `backups` tree, including
`backups/.staging`, is excluded so a bundle cannot recursively archive prior
backups or its own staging data. `media/temp`, `adapters/.staging`, `logs`,
`app.db-wal`, `app.db-shm`, and `.offline-maintenance.lock` are excluded as
transient or operational data. The lease lock is listed explicitly in the
manifest exclusion set but is never copied into a bundle.
Provider-result temporary manifests are therefore not promised to survive as
archive payloads. Durable Job state remains in SQLite and uses the existing
startup recovery path after restore; startup reconciliation handles only the
strictly safe terminal provisional-output cases and preserves ambiguous data.

Every included source path is checked beneath the canonical 0700 data roots.
Symlinks, non-regular files, and hardlink aliases are rejected. Payload files
are copied in bounded chunks and staged with mode 0600. The staged directory
is fsynced, verified against its manifest, reserved with a collision-safe
directory creation, and renamed into `backups` atomically. A failure removes
only artifacts created by that invocation.

The implementation snapshots the canonical parent directory chain and checks
each directory's device/inode before and after sensitive open/copy/rename
operations. Node's promise filesystem API does not expose an `openat2` or
`renameat2` capability here, so a same-UID attacker that replaces a path in the
small interval between those checks is outside the atomicity boundary; the
post-check detects the replacement and fails closed rather than following it.

Installed adapters are revalidated with the existing bounded manifest parser,
source policy, export policy, and declared SHA-256 digest before they are
archived. They are executable trusted code and remain subject to the existing
administrator controls after restore.

During verify, every database asset reference must also agree with its media
role: `output` content is under `media/originals`, `mask` content under
`media/masks`, other input roles under `media/uploads`, thumbnails under
`media/thumbnails`, and posters under `media/posters`. Database or adapter
paths cannot satisfy those constraints.

## Lease and CLI boundary

Archive creation requires an `OfflineMaintenanceLease`. The lease proof binds
to the canonical data root, uses the exclusive 0600 `.offline-maintenance.lock`
gate, and is held for the whole operation. The application server acquires a
different runtime-lease kind on that same gate before initializing storage or
opening SQLite. On first boot it may create only the absent root as a canonical
0700 directory owned by the current user; existing roots are never recreated or
chmod-ed before the gate is held. Therefore
an offline CLI and a running server compete atomically: a running server makes
CLI `create` fail closed, and a held offline lease makes a new server fail
closed. No process is stopped or killed by either code path.

The server releases its gate only after its JobRunner, adapter workers, backup
service, and SQLite connection have closed. A process terminated without the
normal close path can leave an unknown stale gate. Stale or malformed gates are
intentionally not removed automatically; an operator must establish that the
original process is gone and perform the separately controlled recovery before
retrying. This avoids allowing a second process to open the same data root
after an ambiguous failure.

The production CLI opens the source SQLite database read-only, acquires the
offline gate, creates the archive, closes SQLite, and then releases the gate.
It never reads `APP_SECRET` or `APP_PASSWORD`, and its result line contains
only the archive id and bounded metadata. The standalone `verify --bundle PATH`
command does not access live storage and may verify an already-published bundle
while the server is running.

## Operator commands

After building the server, the host command is:

```text
pnpm data-archive create --data-dir /var/lib/imagine-media-studio/data
pnpm data-archive verify --bundle /var/lib/imagine-media-studio/data/backups/<id>.bundle
pnpm data-archive restore --bundle /var/lib/imagine-media-studio/data/backups/<id>.bundle --target /var/lib/imagine-media-studio/restored-v1
```

For the single-container deployment, stop only the task's own Compose project
before creating an archive or switching to a restored root. The one-shot CLI
container does not publish the application port or start service dependencies:

```text
docker compose stop imagine-media
docker compose run --rm --no-deps --entrypoint node imagine-media dist/maintenance/data-archive-cli.js create --data-dir /data
docker compose run --rm --no-deps --entrypoint node imagine-media dist/maintenance/data-archive-cli.js verify --bundle /data/backups/<id>.bundle
docker compose run --rm --no-deps --entrypoint node imagine-media dist/maintenance/data-archive-cli.js restore --bundle /data/backups/<id>.bundle --target /data/restore-target
docker compose start imagine-media
```

The restore target must be absent and its parent must be a canonical 0700
directory. Restore is target-only: it never replaces the active bind-mounted
`/data` directory. After inspecting the target, stop the deployment and change
the host bind mount to the restored data root before starting the application.

Neither `APP_SECRET` nor `APP_PASSWORD` is read from the environment or
written to the bundle. Provider credential ciphertext may remain inside the
SQLite snapshot because it is application data; decrypting it still requires
the separately managed application secret after restore.

## Offline restore

The restore command is target-only:

```text
data-archive restore --bundle PATH --target PATH
```

It first verifies the complete bundle, requires `PATH` to be absent, rejects
bundle/target containment and unsafe canonical parents, and stages the new
0700 data root beside the target on the same filesystem. It recreates the
standard `app.db`, five media trees, `adapters` plus empty
`adapters/.staging`, `backups`, `logs`, and `media/temp` directories. Payloads
are copied with mode 0600, chunk hashes, adapter policy/digest checks, SQLite
integrity/FK checks, and asset role/path/hash checks before an empty target
reservation is atomically renamed into place. At each detectable replacement
point, failures clean only this invocation's stage or empty reservation; a
populated or replaced reservation is left intact when its replacement is
observed.

The restore process never reads `APP_SECRET` or `APP_PASSWORD`. Provider
credential ciphertext remains application data in the SQLite snapshot and
requires the same externally managed application secret after activation.
The standalone CLI reports only entry count, byte count, and archive time; it
does not print bundle/target paths or secrets. A Docker bind-mounted `/data`
root still cannot be atomically replaced in place with one rename, so an
operator must switch the deployment to the newly restored data root.

As with archive creation, Node's promise filesystem API does not provide
`openat2`/`renameat2` for a fully atomic parent-chain operation. The restore
implementation records and rechecks canonical parent device/inode identities
and fails closed on detected replacement; a same-UID replacement in the
small interval between checks remains outside the atomicity boundary.

## Remote acceptance

Commit `4dc4432` passed all 17 jobs in
[GitHub Actions run 33216883872](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33216883872).
The isolated single-container job created and verified a full archive, restored
it to an absent task-owned root, checked standard directory/file modes and
database/media/adapter integrity, started the server against the restored root,
applied the current immutable migration chain, retrieved legacy and current
Assets, and verified persistence after restart. The job used one Compose
service and cleaned only its unique project and temporary data roots.
