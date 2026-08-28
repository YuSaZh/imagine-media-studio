# PR 8 Media Consistency

Status: **First milestone implemented; full PR 8 acceptance remains pending.**

This milestone provides a bounded media consistency audit, an authenticated
administrator report, and startup cleanup for deterministic Provider
provisional output. It does not add a durable repair queue or migration `0007`,
and it never automatically deletes an orphan or an Asset-referenced managed
media file.

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
temporary files, scan unmanaged roots, or repair managed-tree orphans. Durable
repair, operator-selected actions, and additional retention controls remain
future work.

## Acceptance evidence

Targeted unit coverage verifies bounded scans, size/hash/missing/orphan/unsafe
findings, hash-budget truncation, active-output reservation, terminal cleanup,
referenced completed output preservation, unknown-directory preservation, and
incomplete-reference fail-closed behavior. Route and server tests verify the
strict request boundary, administrator protection, no-store response, CSP, and
safe DTO projection.
