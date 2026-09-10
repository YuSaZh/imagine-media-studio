# Current Architecture

This is the maintained architecture entry for Imagine Media Studio. Contributor
workflow lives in [CONTRIBUTING.md](../../CONTRIBUTING.md); repository instructions
for agents live in [AGENTS.md](../../AGENTS.md) and its scoped guides.

## Product and Topology

The application provides image/video creation, editing, tasks, projects, and media
management using user-provided external APIs. It does not host model inference,
GPU scheduling, a billing platform, or a general-purpose API gateway.

```text
Browser / installed PWA
  | same-origin internal APIs and SSE
  v
One Node.js application / Fastify / one application port
  |-- authenticated routes and account-scoped services
  |-- in-process JobRunner and bounded queues
  |-- Provider adapters and guarded HTTP transport --> external APIs
  |-- media processing and managed files
  `-- SQLite and durable event outbox
        `-- one /data volume
```

Production serves the compiled UI and API from one business container. Bounded
FFmpeg/ffprobe subprocesses and trusted adapter worker threads do not introduce
another application service. An operator may supply an existing reverse proxy;
the project does not require a proxy container, Redis, PostgreSQL, or object store.

Mock generation is opt-in through `MOCK_PROVIDER_ENABLED=true`. Server, Compose
and environment examples default to false. With the switch off, catalog queries
exclude stored Mock connections and models before pagination, and the registry
rejects Mock execution. Existing media, task history and saved test configuration
are retained. Isolated browser and Docker tests explicitly enable the switch.

## Module and State Ownership

| Area | Responsibility |
| --- | --- |
| `apps/web` | React workspace, separate desktop/mobile layouts, TanStack Query server state, temporary interaction state, PWA |
| `apps/server` | Fastify routes, authorization, encrypted secrets, SQLite repositories, jobs, media, Provider protocols |
| `packages/shared` | Zod validation, internal API contracts, model policies, portable pure helpers |
| `packages/provider-contract` | Provider-neutral adapter interfaces and normalized results/errors |
| `packages/testkit`, `fixtures`, `e2e` | Deterministic verification data and browser workflows |

SQLite owns durable accounts, settings, jobs, assets, and collections. The current
application authenticates accounts and isolates their data; Provider/model
administration is shared and administrator-controlled. Generation memory keeps
project, media type, and Provider/model choices separate within an account.
Account management is separate from generation preferences.

The browser refetches authoritative state after SSE invalidation. It does not own
job execution or retain a parallel global inventory of server records. Offline
mode supports bounded authorized previews and drafts, disables writes, and excludes
secrets and full videos from caches. See the [workspace spec](../design-spec/workspace.md).

## Provider and Job Boundaries

Model capabilities and stored parameter policies drive controls and server
validation. The server selects and snapshots the model's wire protocol for a job.
Image resolution metadata declares native/pixel mode, permitted values and
dimension limits. The server owns the durable `imageResolutionPolicy` snapshot,
ignores a client's replacement, and passes it to adapters through context while
excluding it from the Provider request. Frontend and server use shared validators;
known model names only supply default metadata, never override explicit policy.
Generation count is an application fan-out count (1-32), excluded from model
parameter policy even when legacy model records contain count rules. The job
route creates that many durable jobs with one requested output each. Image/video
submissions and due polls have no application concurrency cap across accounts or
Providers; upstream APIs govern their own concurrency and rate limits. Download
and local processing queues remain bounded (3 and 2 respectively). Per-job
deduplication, polling intervals, timeouts, cancellation and retry budgets remain
in force.
Adapters map vendor payloads and normalize URLs, Base64, MIME, states, and errors.
Operation-specific policies and video input constraints are shared with the UI
and snapshotted by the server. Editing/extension inputs use stored assets and
server-only `asset_video_sources` records, never client-supplied remote IDs.
The additive migration backfills eligible existing video jobs; output finalization
stores provenance atomically and links derived assets to their source.
Large Base64 payloads use a shared linear canonical validator before decoding;
encoded and decoded byte limits remain enforced. Unexpected internal processing
failures are classified separately from missing model protocols and do not
automatically trigger another generation request.
Connection/catalog success does not establish that generation will succeed.

All Provider requests and remote media downloads use the guarded transport with
bounded requests, network policy, DNS pinning, and redirect revalidation. Credentials
are encrypted using `APP_SECRET` and never returned through DTOs, previews, logs,
PWA storage, or exported configuration. HTTP access for both Provider calls (including scoped custom adapters) and media downloads uses the global persisted `network.allow_http_content` setting, enabled by default and writable only by administrators. Policies evaluate it on each URL validation so changes apply without restart. On first initialization, either legacy HTTP environment variable set to false initializes it as disabled; subsequent restarts preserve the stored value. Private-network access remains a separate opt-in; cloud metadata endpoints stay forbidden.

The JobRunner commits state and outbox events before live notification, bounds local
media work, retains retry budgets, and resumes known remote jobs after restart. Uncertain
submissions must not be blindly repeated without an idempotency guarantee. Protocol
fallback handles classified incompatibility, not every failed request.

Declarative HTTP adapters remain validated data. Administrator-installed JavaScript
is trusted code executed in bounded worker threads, not an untrusted-code sandbox.
See the [adapter runtime guide](../../apps/server/src/adapters/README.md).

## Persistence and Maintenance

- Keep SQLite migrations additive and shipped SQL/checksums immutable. Verify
  upgrade and recovery against existing data formats.
- Store relative managed paths and persist upstream results locally. Preserve
  path/symlink guards, byte limits, signature validation, atomic publication,
  original downloads, and video Range delivery.
- Database backups do not include all media. Full offline archives preserve the
  managed data tree; operators retain `APP_SECRET` separately for encrypted data.
- Runtime/offline maintenance exclusion and resource ownership must survive errors.
  Repair only classified safe cases; preserve ambiguous or referenced files.

Subsystem references, with their original milestone evidence retained:
[data archives](./pr8-data-archive.md), [SQLite integrity](./pr8-sqlite-integrity.md),
[media consistency](./pr8-media-consistency.md).

For local verification use the [contribution matrix](../../CONTRIBUTING.md#verification).
For deployment use [RELEASE.md](../../RELEASE.md). Outstanding external acceptance
and known limitations are recorded in [Hold.md](../../Hold.md).

### Mask input preparation

`supportsMask` continues to describe native protocol support. Image-input models without native masks can accept a server-prepared overlay: canonical mask alpha 0 denotes edited pixels, alpha 255 preserved pixels, and intermediate values partial coverage. Version 1 uses RGB (235, 64, 82) with opacity 104/255. Browser previews and server compositing share these constants.

New masked jobs snapshot `maskProcessing` in request JSON: version, native/overlay mode, source identity, output MIME and optional model byte bound. The input resolver derives it from stored capabilities, overwriting client values. Historical jobs without the snapshot retain their previous behavior. No database migration or standalone composite asset is required. Source/mask ownership, parent relation, dimensions and input counts are validated before processing.

The existing input loader uses bounded Sharp processing for overlay snapshots (up to 16,777,216 decoded pixels, also subject to existing editor/upload/model limits), preserves dimensions and checks encoded size against model/application limits. It replaces the source bytes in memory, strips its original public URL, and removes the independent mask from provider inputs. Native snapshots retain source and mask separately. `providerGenerationRequest` strips processing metadata and appends fixed overlay guidance only to the outbound prompt; the user's stored prompt and original media remain unchanged. Submit-time validation and the durable runner use the same preparation path, including retries and recovery. Model edits cannot change a queued job's snapshot. Non-native overlay guidance is not a guarantee of exact regional editing.

Job detail responses map input records to the shared DTO (`assetId`, `role`, `sortOrder`), excluding repository-only `jobId`, so editors can validate and observe jobs that contain image inputs.

## Account settings and authentication

Settings keys accept up to 128 characters, including the existing `generation.edit.<projectId>.<assetId>` format. Workspace and editor scopes share one constructor; existing keys and values remain readable without migration. Account single-key reads query that key directly.

Password login and HTTP Basic share an in-memory per-source-IP attempt window (10 attempts in 60 seconds, checked before password work and cleared on success). Password creation, validation and updates use asynchronous scrypt with the existing salt/hash format. Each request caches its Basic authentication work; later authorization and SSE delivery revalidate account enabled state and session version without repeating the KDF. Cookie expiry remains enforced, including on long-lived streams. Account changes during asynchronous verification invalidate its result; concurrent credential updates use revision checks. Cookie-only requests do not consume password attempts.

Each settings PATCH commits one outbox row with key names and no values in the same transaction. `settings.updated` events contain `keys`; account changes use the account ID and global changes use `global` as the entity ID. For mixed writes, server-only routing metadata permits recipient-specific projection: the owner sees all changed keys, other accounts see only global keys. The same projection applies to replay and live delivery; routing metadata never reaches the SSE wire. Legacy reset events remain valid. Browser clients refresh settings, and additionally refresh workspace assets when recent-series history changes. Notifications received during local optimistic settings writes are coalesced until those writes settle.

Series queries load one account's primary-parent graph and resolve roots with an iterative memoized traversal, rather than expanding every asset's ancestry in SQL. Missing parents end a chain; cycles use the smallest cycle node ID as their canonical root. Temporary/deleted nodes preserve lineage, while visible assets remain subject to the existing filters. Root mappings enter SQLite through a JSON relation; grouping, cover ranking and stable cursor pagination stay in SQL. Series detail uses the same graph and retains its 1000-node visible traversal bound. No persistent graph cache or database migration is introduced.
