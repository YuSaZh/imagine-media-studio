# PR 8 Media Consistency

Status: **Bounded media audit, repair queue, and one-shot derived repair implemented; full PR 8 acceptance remains pending.**

This milestone provides a bounded media consistency audit, an authenticated
administrator report, startup cleanup for deterministic Provider provisional
output, the independent durable repair queue core from migration `0007`, and a
bounded one-shot administrator repair action. It never automatically deletes
an orphan or an Asset-referenced managed media file.

## Audit boundary

`GET /internal/maintenance/media` requires the configured administrator and
accepts no query parameters or request body. The response contains only bounded
counts, a bounded list of issue records, and `ok`/`truncated` flags. It does
not expose absolute paths, filesystem errors, file contents, database rows, or
Provider payloads.

The default limits are:

- 10,000 Asset rows;
- 20,000 managed filesystem entries;
- 512 MiB of hashed content;
- 100 returned issue records.

The implementation also enforces hard upper bounds when called internally.
Exceeding an asset, file, hash, or issue budget marks the report truncated and
the report cannot claim `ok`.

For each retained Asset row, including soft-deleted rows kept for reference
safety, the audit validates its content path, optional thumbnail, and optional
poster using the existing stored-path and no-symlink guards. Content size and
SHA-256 are checked while the hash budget permits.
The managed `originals`, `thumbnails`, `posters`, `uploads`, and `masks` trees
are then streamed and compared with the complete Asset reference set. Missing,
modified, unsafe, unreadable, and orphaned entries are reported. A partial
Asset set or a partial filesystem scan reports truncation instead of making an
unsafe deletion decision.

Active Jobs reserve their deterministic Provider output paths during the scan,
so in-progress output is not reported as a managed-tree orphan. The scan does
not inspect or return Provider manifest contents.

## Startup reconciliation

Before the in-process `JobRunner` starts, the server streams
`media/temp/provider-results`. A directory is eligible only when its name is
the deterministic hash of a known Job and that Job is terminal. A manifest is
eligible only when it has the strict `slot-0000.json` naming form. Before
deleting a slot, the implementation loads the complete bounded Asset reference
set and proves that none of the deterministic original, thumbnail, or poster
paths is referenced.

For an unreferenced terminal slot, all deterministic Provider output variants
are attempted first. The manifest is removed only after every output is
removed or already missing; an unsafe or failed output removal leaves the
manifest for a later retry. A completed Job with a referenced Asset loses only
its stale manifest; referenced output remains durable. Active, unknown,
non-regular, unsafe, malformed, out-of-bound, or referenced non-completed
entries are preserved. An incomplete Job or Asset query disables deletion for
that startup pass and reports truncation in the cleanup result.

The cleanup is deliberately narrow: it does not recursively remove arbitrary
temporary files, scan unmanaged roots, or repair managed-tree orphans. The
repair worker is intentionally not resident: an administrator invokes one
fixed-size batch at a time. Broader operator-selected actions, automatic
orphan handling, and additional retention controls remain future work.

## Durable repair queue core

Migration `0007_pr8_media_repair_queue.sql` adds a bounded queue keyed by a
stable SHA-256 of the normalized issue kind, Asset/Job identifiers, and stored
path. The queue keeps only safe relative paths or the explicit
`<unsafe-path>`/`<path-too-long>` sentinels; it never stores an absolute path,
raw filesystem error, stack trace, or response body. `asset_id` and `job_id`
use foreign keys with `SET NULL`, so queue history survives deletion of the
source row without creating a dangling reference.

`MediaRepairQueueRepository.upsertScan()` sorts and de-duplicates a bounded
issue set. Only a complete, non-truncated scan can mark absent `open` rows as
`resolved`; an expired `running` lease is first reclaimed to `open`, while a
still-valid lease is never bulk-resolved. A truncated scan never bulk-resolves
old work. Reappearing resolved issues reopen deterministically and clear stale
error codes, while manual rows remain manual until an explicit retry or state
transition.

Claims are transactional compare-and-set updates. A claim increments
`attempts` and sets a bounded lease; an expired running lease returns to
`open`. Resolve, manual, and retry transitions can require the claimed
attempt/lease pair, preventing an old worker from completing a newer claim.
Retry scheduling uses deterministic exponential backoff with a hard maximum,
and only a bounded error code token is retained.

The integration coordinator now connects the bounded audit to the durable
queue. `POST /internal/maintenance/media/reconcile` requires the configured
administrator and an empty request, persists only safe `assetId`/`kind`/path
issue data with `jobId` reserved as null, and returns bounded scan and queue
counts. `GET /internal/maintenance/media/repairs` exposes a fixed bounded page
and total count of safe queue DTOs; it accepts no state or limit query
parameters. Both responses are `no-store` and inherit the server CSP and
same-origin write policy.

## Bounded derived repair

`POST /internal/maintenance/media/repairs/run` requires the configured
administrator and an empty request body/query. It claims one fixed-size batch
from the queue and returns only `attempted`, `repaired`, `manual`, `retried`,
and `truncated` counts. The endpoint has no caller-controlled limit and does
not start a resident worker. One process accepts only one active run: a
concurrent administrator request receives a safe `409` response before it can
claim another batch.

Only `missing` issues with a live Asset can be considered for automatic repair.
The queue path must exactly match the Asset thumbnail/poster reference, the
primary file must be a regular no-symlink file in the role-specific tree with
the recorded size and SHA-256. Deterministic missing/symlink/path/size/hash
problems, deleted Assets, orphan issues, invalid metadata, and collisions are
sent to manual review; transient primary open/read I/O failures use a safe
bounded retry code. Transient derived-path inspection failures likewise retry
with a fixed safe code rather than becoming manual work. Before generation,
the primary is opened and checked
again, including its device/inode identity and hash, to narrow the same-UID
path-replacement window.
Image thumbnails and video posters use the existing processor staging,
fsync, and no-replace hard-link publication paths. The deadline signal is
checked after each publication preparation await and immediately before the
hard link; an abort removes the staged file without publishing the destination.
The worker verifies the published file before a guarded queue resolve. A claim deadline aborts the
processor one second before lease expiry; claims with less than that margin
are left unsettled and are not started. Tool and transient storage failures
retain only a bounded error code and use the queue's bounded retry backoff.
An expired lease is never used to publish a file, and a stale worker cannot
resolve a newer claim. If a queue transition fails or loses its lease, the
run reports `truncated` without falsely counting the row as repaired, manual,
or retried. Wire counts are capped at the endpoint batch size of ten; a
non-truncated response accounts for every attempted claim. The action does not
delete user media or repair primary files.

The coordinator and queue core have no resident worker. Media-service repair
execution is limited to the safe derived cases above; administrator state
actions, primary-file repair, and additional retention controls remain
separate work. No automatic orphan deletion is introduced.

## Acceptance evidence

Targeted unit coverage verifies bounded scans, size/hash/missing/orphan/unsafe
findings, hash-budget truncation, active-output reservation, terminal cleanup,
referenced completed output preservation, unknown-directory preservation, and
incomplete-reference fail-closed behavior. Queue tests verify new/old database
migration, manifest drift, schema checks, foreign-key nulling, deterministic
idempotent upsert, concurrent claims, lease expiry/restart, bounded retry,
manual/resolve transitions, and truncated-scan behavior. Worker tests verify
real image thumbnail generation, video poster integration, primary and
deleted-Asset safety, collisions, safe retries, stale leases, fixed-batch
truncation, deadline aborts, and unsettled queue transitions. Primary
revalidation compares the path, device/inode identity, size, and hash before
the processor opens the source. Coordinator, route, server, and client tests
verify truncated propagation, active-lease retention, strict request
boundaries, administrator/CSRF protection, restart persistence, no-store/CSP
headers, safe DTO projection, and bounded repair outcome invariants.
