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
Adapters map vendor payloads and normalize URLs, Base64, MIME, states, and errors.
Connection/catalog success does not establish that generation will succeed.

All Provider requests and remote media downloads use the guarded transport with
bounded requests, network policy, DNS pinning, and redirect revalidation. Credentials
are encrypted using `APP_SECRET` and never returned through DTOs, previews, logs,
PWA storage, or exported configuration. Private-network/HTTP access uses explicit
operator settings; cloud metadata endpoints stay forbidden.

The JobRunner commits state and outbox events before live notification, bounds each
stage, retains retry budgets, and resumes known remote jobs after restart. Uncertain
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
