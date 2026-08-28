# PR8 Data Archive Core

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
archive payloads; a later restore/reconciliation milestone must normalize
non-terminal jobs and requeue them where necessary.

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
administrator controls after a future restore.

During verify, every database asset reference must also agree with its media
role: `output` content is under `media/originals`, `mask` content under
`media/masks`, other input roles under `media/uploads`, thumbnails under
`media/thumbnails`, and posters under `media/posters`. Database or adapter
paths cannot satisfy those constraints.

## Lease and CLI boundary

Archive creation requires an `OfflineMaintenanceLease`. The lease proof binds
to the canonical data root, uses an exclusive 0600 lock, and requires the
caller to prove that the application is stopped. It is held for the whole
operation and can be verified again before copying begins. The current server
does not yet issue this lease. Consequently the standalone CLI `create`
command fails closed until a server/operator integration supplies one. Server
mutual-exclusion integration is intentionally not implemented in this
milestone;
ordinary CLI invocation cannot be mistaken for an offline window. The
standalone `verify --bundle PATH` command does not access live storage and may
verify an already-published bundle.

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
