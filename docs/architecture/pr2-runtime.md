# PR 2 Application Runtime

## Scope

PR 2 turns the PR 1 interface shell into a persistent single-user application while preserving the original runtime boundary: one Node.js process, one SQLite database, one HTTP port, and one `/data` volume. The Mock Provider remains the only executable Provider adapter. Real Provider HTTP integrations begin in PR 4.

## Ownership

```text
Browser / installed PWA
  | same-origin /internal requests + one SSE connection
  v
Fastify in the single Node.js process
  |-- safe DTO routes
  |-- ProviderService + encrypted SecretVault
  |-- in-process JobRunner + bounded queues
  |-- media validation, derivatives, Range delivery
  `-- SQLite repositories + durable change-event outbox
        |
        `-- /data/app.db and /data/media/**
```

- SQLite is authoritative for settings, Provider metadata, models, Jobs, Assets, Collections, output slots, and the change-event log.
- TanStack Query owns browser server state. SSE events are invalidation hints; clients refetch authoritative GET responses.
- The in-process JobRunner uses revision compare-and-set transitions. Job state and its durable event are committed before live subscribers are notified.
- Provider submission, polling, remote download, and media processing use separate bounded queues. Poll waits do not occupy submission slots.
- The server serves both the compiled PWA and internal routes on `APP_PORT`.

No Redis, PostgreSQL, object store, worker process, second Node process, or second business container is introduced.

## Secret Boundary

Provider API keys and custom headers are encrypted with AES-256-GCM using a per-field salt and IV. HKDF derives encryption keys from `APP_SECRET`, and Provider ID plus field name are authenticated as associated data.

- Storage records contain ciphertext envelopes only.
- Decryption occurs only inside `ProviderRegistry.resolve()` immediately before an adapter call.
- Provider DTOs expose `hasApiKey` and `hasCustomHeaders` booleans, never plaintext or ciphertext.
- Settings reject secret-like keys so credentials cannot bypass Provider storage.
- Browser responses, logs, PWA cache data, and exported configuration must not contain Provider secrets.

Production startup rejects a short or placeholder `APP_SECRET`.

## Media Boundary

All managed paths are relative to `/data` in SQLite. Path resolution rejects traversal and symbolic-link escapes. New media is streamed into a `0600` temporary file, hashed and size-limited, signature-inspected, decoded or probed, and atomically renamed before its database record is committed.

- Images are validated by signature and Sharp decoding; a bounded 512px WebP thumbnail is derived.
- Videos are probed with bounded `ffprobe`; a poster is created by bounded `ffmpeg` commands using a file-only protocol allowlist.
- Upload and remote-result limits are configured independently for image and video media.
- Remote URLs default to HTTPS, resolve every address before use, reject unsafe address ranges and metadata hosts, pin the validated address, and revalidate every redirect.
- Cross-origin redirects lose secret headers.
- Media GET/HEAD supports one byte range, `If-Range`, strong ETags, and `416` responses.
- Deletion is soft at the database boundary; maintenance can audit missing, modified, unsafe, and orphaned files without deleting them automatically.

## Recovery

On startup, the Runner scans durable nonterminal Jobs:

- `queued` work is submitted;
- replay-safe `submitting` work without a remote ID is requeued with the same idempotency key;
- remote work resumes polling;
- downloaded and processing work resumes from its durable manifest;
- completed work with a recoverable materialized manifest repairs its output slots;
- completed work with neither valid outputs nor a recoverable manifest becomes `output_consistency_error` instead of re-submitting a Provider request.

`submit_attempt` limits automatic submission attempts for one Job. `retry_count` separately records explicit user-created retry lineage, and every explicit retry creates a new Job ID and idempotency key.

## Internal API Security

Internal JSON contracts are strict and versioned through shared schemas. Browser writes with an `Origin` header must match the request Host. Internal responses send no-store and content-sniffing protections; media responses use explicit private revalidation headers. The API is an application-internal boundary, not a public Provider-compatible API.

## Validation

Local validation is limited to non-listening lint, typecheck, unit tests, and Fastify injection tests. GitHub Actions owns the production build, Playwright browser execution, Docker image build, and isolated single-container restart smoke. The Actions smoke uses a unique Compose project and temporary `0700` data directory and always cleans both.
