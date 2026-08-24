# PR 0 Runtime Architecture

## Purpose

PR 0 establishes the smallest deployable application skeleton. It proves that the Web app, internal API, SQLite persistence, and recoverable Mock jobs can run together without introducing platform infrastructure or a real generation integration.

This application is a lightweight self-hosted WebUI. It is **not** a model server and does not expose a general-purpose image or video generation API. Model inference remains the responsibility of user-supplied external Providers in later PRs.

## Runtime Topology

```text
Browser / installed PWA
          |
          | HTTP on APP_PORT
          v
One Docker business container
└── One Node.js main process
    ├── Fastify internal HTTP API
    ├── Fastify static hosting for the React/Vite build
    ├── SQLite connection -> /data/app.db
    └── In-process JobRunner singleton
        └── PR 0 Mock Provider only (zero network access)
```

Runtime invariants:

- Docker Compose contains exactly one business service.
- The container runs exactly one Node.js main process for the application.
- React is built ahead of runtime. The same Fastify process that serves the internal API serves the compiled React/Vite assets and SPA fallback.
- JobRunner is an in-process singleton, not a worker service or second container.
- SQLite is the only database and is stored at `/data/app.db`.
- All durable runtime state lives below `/data`.
- PostgreSQL, Redis, MinIO, Nginx, a separate Worker, and a separate frontend server are outside PR 0.

## Process Ownership

| Concern | PR 0 owner | Separate process/service allowed? |
| --- | --- | --- |
| Static React build | Fastify static hosting | No |
| Internal HTTP routes | Fastify | No |
| Job scheduling and recovery | In-process JobRunner singleton | No |
| Database connection and migrations | Node process + SQLite/Drizzle | No |
| Mock generation result | In-process Mock Provider | No |
| Model inference | Not present in PR 0 | No |

The server may use normal Node library facilities, but PR 0 does not introduce a process supervisor, message broker, sidecar, or background browser task.

## Startup Sequence

The runtime must initialize in this order:

1. Resolve configuration and the `/data` storage paths.
2. Create required storage directories without deleting existing content.
3. Open `/data/app.db` and apply pending migrations.
4. Record each applied migration in `schema_migrations`.
5. Construct repositories, the Mock Provider, and the JobRunner singleton.
6. Register internal routes and compiled React static hosting on the same Fastify instance.
7. Start JobRunner recovery for queued Mock jobs.
8. Listen on `APP_PORT` only after required initialization succeeds.

A migration or storage initialization failure must fail startup. The process must not accept requests against an unknown or partially migrated schema.

## SQLite And Migration Contract

PR 0 persistence requirements:

```text
DATA_DIR=/data
DATABASE_PATH=/data/app.db
```

- `schema_migrations` is mandatory and records at least `version` and `applied_at`.
- Migration versions are immutable once merged. Schema changes add a migration instead of editing an already released migration.
- Applying migrations is idempotent: restarting against an up-to-date database performs no destructive work.
- Database records store relative media paths where applicable; `/data` remains portable as one backup unit.
- Container replacement must preserve data when the same `/data` volume is mounted.

Minimum PR 0 recovery case:

1. A Mock job exists with `queued` status in SQLite.
2. The Node process starts or restarts.
3. The in-process JobRunner discovers the queued row.
4. The Mock Provider completes it deterministically.
5. The completed job and output asset remain in `/data` after another restart.

## HTTP Boundary

The Fastify routes are private application-internal interfaces used by the same React application. They exist to support the WebUI and later keep Provider credentials out of the browser.

They are not a public model inference product, OpenAI-compatible generation API, multi-tenant platform, or promise of a stable third-party API. PR 0 must not add:

- real Provider credentials or outbound Provider calls;
- OpenAI, Gemini, xAI, or custom Provider integrations;
- users, organizations, billing, quotas, or GPU scheduling;
- server-side model execution.

Real Providers are explicitly deferred beyond PR 0.

## Shutdown

On `SIGINT`, `SIGTERM`, or Fastify close:

1. Stop accepting new work.
2. Stop JobRunner scheduling and wait for its current bounded Mock work to settle.
3. Close the SQLite connection.
4. Close the Fastify process cleanly.

The recovery contract handles any queued durable work left by an interrupted process.

## Validation Ownership

Development on this host must not affect existing running services. Local dependency installation, lint, typecheck, and isolated unit tests are allowed because they do not bind ports or manipulate services. This task does not start a local server, run a production build, launch E2E, or invoke Docker/Compose.

GitHub-hosted Actions own executable validation for PR 0:

| Validation | Execution environment |
| --- | --- |
| Lint and typecheck | Local non-runtime check + GitHub-hosted Actions |
| Unit tests | Local isolated check + GitHub-hosted Actions |
| React/server production build | GitHub-hosted Actions |
| Playwright E2E/PWA checks | GitHub-hosted Actions |
| Docker image build | GitHub-hosted Actions |
| Single-container smoke and restart persistence | GitHub-hosted Actions |

The Docker smoke workflow must verify one Compose service, health, Mock job completion, `/data/app.db`, migration state, output persistence, container restart recovery, and absence of additional business services.

## PR 0 Acceptance Checklist

- [ ] Compiled React assets are served by the same Fastify process as the internal API.
- [ ] Only one Node.js main process and one Compose business service exist.
- [ ] SQLite is created at `/data/app.db`.
- [ ] `schema_migrations` exists and migration application is idempotent.
- [ ] One in-process JobRunner resumes queued Mock jobs.
- [ ] Mock execution makes no network request and produces deterministic output.
- [ ] No real Provider or model inference code is enabled.
- [ ] GitHub-hosted Actions, not this development host, execute build/E2E/Docker validation.
