# Changelog

All notable changes to Imagine Media Studio are documented in this file.

## [Unreleased]

### Fixed

- Remember image/video model selections and per-model generation parameters
  independently for each project, saving changes before submission.
- Give account management its own settings category.
- Offer the complete remote model catalog when adding a model, with common
  display-name mappings and an exact model-ID fallback.
- Allow individual models to use OpenAI, Gemini, or xAI protocols independently
  of the connection's default interface.
- Validate repository release provenance against BuildKit's emitted SLSA v1
  `buildDefinition` and `runDetails` structure for both supported platforms.

## [0.1.0] - 2026-08-29

### Added

- A clean pnpm monorepo with one Fastify/React application process, one SQLite
  database, one port, one `/data` volume, an in-process recoverable JobRunner,
  and a deterministic Mock Provider.
- Responsive Composer, Gallery, Viewer, Collections, Settings, image editing,
  masks, multi-reference input, native video playback, poster generation,
  download, and HTTP Range delivery flows.
- Server-side encrypted Provider configuration and capability-driven OpenAI,
  Gemini, and xAI image/video protocol profiles, verified with deterministic
  fixtures rather than production credentials.
- Declarative custom HTTP adapters and administrator-installed Trusted
  JavaScript adapters with immutable revisions, bounded validation/execution,
  exact host allowlists, and server-injected network and secret access.
- An installable Workbox PWA with bounded same-origin media caching, offline
  prompt recovery, session-scoped Gallery/Job snapshots, update controls,
  reconnect refresh, and eight-viewport interaction automation.
- PR 8 project-owned pixel-diff baselines at 1440x900, 1920x1080, 390x844,
  and 430x932. These are deterministic product regressions, not Grok reference
  comparisons or physical-device evidence.
- Authenticated database integrity, database-only online backup, bounded media
  audit/reconciliation, a durable repair queue, safe one-shot derived-media
  repair, and an offline full-data archive create/verify/target-only restore
  CLI.
- A tag-gated multi-platform GHCR pipeline with SBOM, maximum BuildKit
  provenance, GitHub artifact attestation, digest-based smoke testing, delayed
  stable-tag promotion, and GitHub Release creation from these notes.

### Security

- Provider and remote-media transport validates every DNS result and redirect,
  pins the selected address, blocks private and cloud-metadata destinations by
  default, bounds payloads and timeouts, and never exposes Provider credentials
  to the browser, PWA cache, exported configuration, or logs.
- Provider credentials are encrypted at rest with AES-256-GCM under the
  operator-managed `APP_SECRET`; the optional `APP_PASSWORD` adds a server-side
  session gate. A potentially public host without a password receives a
  persistent startup warning with an explicit per-mount bypass.
- Immutable migration manifests and recorded checksums protect SQLite upgrade
  history. Startup, online backups, archives, and restores use integrity and
  foreign-key checks with bounded, redacted results.
- Backup, archive, restore, media, and adapter paths reject traversal,
  symlinks, hardlink aliases where applicable, unsafe modes, collisions, and
  detectable replacement races; publication and cleanup are scoped to
  invocation-owned staging data.

### Operations

- Production remains a single container. Persistent application data belongs
  under `/data`; `APP_SECRET` and `APP_PASSWORD` remain external environment
  configuration and are not included in archives. Encrypted Provider credential
  ciphertext remains in SQLite snapshots and archives and must still be treated
  as sensitive data.
- Full-data archive creation is offline and mutually exclusive with the server.
  Verification is standalone and read-only. Restore creates a new absent data
  root and never overwrites the active bind mount.
- Database migrations run forward on startup. There are no automatic down
  migrations; rollback requires a verified pre-upgrade archive and an explicit
  bind-mount switch to a restored target.

### Known limitations

- Authenticated private Grok Imagine references are unavailable, so this
  release does not claim strict L3/L4 or pixel parity with Grok.
- Real installation, standalone relaunch, keyboard, gesture, and safe-area
  evidence remains pending for Windows, macOS, Android, and iOS.
- Live external Provider acceptance remains pending because no production
  credentials or user-approved endpoints are stored in the repository.
- Provider-output cleanup is intentionally conservative; ambiguous or primary
  media repair and orphan deletion require manual handling.
- Dynamic model refresh reads one bounded catalog page, and the original-media
  and temporary-file retention controls remain presentational.
- Offline restore and runtime-lock cleanup retain documented narrow same-UID
  replacement windows because Node's filesystem API lacks the required
  conditional atomic directory operations.

See [Hold.md](./Hold.md) for the authoritative evidence and limitation record,
and [RELEASE.md](./RELEASE.md) for installation, upgrade, recovery, and image
verification instructions.

[0.1.0]: https://github.com/YuSaZh/imagine-media-studio/releases/tag/v0.1.0
