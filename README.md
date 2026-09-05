# Imagine Media Studio

Imagine Media Studio is a lightweight, self-hosted web interface for managing image and video generation through user-provided external APIs.

The default application is the redesigned Imagine workspace. Open `/imagine` for creation, `/library` and `/saved` for media, `/projects` for collections, `/jobs` for task history and `/settings` for connections. The old UI and standalone prototype have been removed. See [workspace design and verification](docs/design-spec/workspace.md).

## Runtime

- Node.js 24, pnpm, React/Vite, Fastify and SQLite/Drizzle.
- One Docker service, one application process, one port and one `/data` volume.
- Capability-driven image/video Providers, encrypted credentials, durable jobs and one browser SSE connection.
- Original media delivery, uploads, masks, thumbnails/posters, native video and server-side search/pagination.
- Authenticated offline previews/drafts, PWA, preferences and custom HTTP/trusted JavaScript adapters.
- Database integrity, backups, media repair and offline full-data archives.

Real generation requires user-configured external APIs. Mock exercises workflows with test outputs; no sample gallery or simulated browser generation is shipped. Credentials stay on the server.

## Verification

Run `pnpm run ci` and `E2E_PORT=<unused-task-port> pnpm test:e2e --update-snapshots=none`. CI checks eight viewport sizes, live workflows, accessibility, visual baselines and the isolated single-container Docker smoke. Backend acceptance and release history remain in `docs/architecture/` and Git history; their earlier page screenshots and selectors do not describe this UI. The published v0.1.0 image predates this redesign; build current source for the new workspace.

## Local Safety

This repository is developed on a host with existing services. Checks that start the application, Playwright, or Docker/Compose must use task-owned temporary data, a unique Compose project/resource namespace, and a non-conflicting port. Never stop, restart, rename, inspect secrets from, or otherwise alter existing host services and containers.

For deployment on another host, create the bind-mounted data directory as the runtime user and pass that user's numeric IDs when they differ from `1000:1000`:

```bash
mkdir -p data
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

Offline archive operations are available through `pnpm data-archive` after a
production build. `create` requires the application to be stopped; `verify` is
read-only and may run while it is online; `restore` creates an absent target
directory and never replaces the active `/data` mount. The complete host and
Docker operator sequence is documented in
[`docs/architecture/pr8-data-archive.md`](./docs/architecture/pr8-data-archive.md).

## Release and upgrade

The release history and known v0.1.0 boundaries are in
[`CHANGELOG.md`](./CHANGELOG.md). Digest-pinned installation, secret handling,
online and full-data backup, migration, restore, rollback, GHCR attestation,
SBOM, and provenance instructions are in [`RELEASE.md`](./RELEASE.md). Treat the
root `package.json` as the release version gate; the server and web app manifests
track that product version, while private internal library workspaces retain
their independent placeholder versions.

## Accounts and Preferences

The initial administrator login is `admin` / `admin`. Set `ADMIN_USERNAME` and
`ADMIN_PASSWORD` before the first start to override these defaults. Existing
assets, jobs, projects and preferences migrate to this administrator. Credentials
are stored as salted password hashes in SQLite; subsequent restarts never reset
them from the environment. `APP_PASSWORD` no longer controls production login.

In Settings -> Preferences, users can change their username and password.
Administrators can create or disable users and configure the public HTTPS domain.
Media, jobs, projects, preferences and remembered model parameters are private to
each account. Providers and model catalogs are shared and administrator-managed.
Changing credentials or disabling an account revokes its existing sessions.

Generation batches create independent jobs with a count of one for each upstream
request. The local runner limits concurrent submissions to two per media type.
Model parameters are remembered when submitting, independently for each account
and model. Video aspect ratio and resolution can be selected together.

## Custom Provider usage

Set the public domain in Settings -> Preferences, or use `PUBLIC_BASE_URL` as the
initial fallback, to send
reference images as signed, 15-minute links on xAI image/video and OpenAI
Responses APIs. The links serve only the selected image, expire automatically,
stop working when the asset is deleted, and are excluded from browser/PWA caches.
Saved preferences take effect without restarting. Without this setting,
references use embedded data or multipart uploads.
Use an HTTPS public URL for xAI image fetching. When terminating HTTPS at a
trusted reverse proxy, set `TRUST_PROXY_HOPS=1` and restrict the application port
to that proxy (for example, a loopback Docker port binding). The proxy must set
`Host` and `X-Forwarded-Proto`; this enables correct origin checks and Secure
session cookies. Direct deployments should retain the default `0`.
OpenAI Images and Gemini continue using the input format required by their API.

The reference button offers library selection and new uploads. Adding an image
reference selects image editing automatically. `auto` leaves aspect ratio and
resolution to the upstream. Generation tasks appear inside the waterfall grid.
Selecting a project in the header scopes its resources and stores new generated
outputs in that project, including after server recovery.

Open Settings -> Providers -> Manage adapter for a `Custom HTTP Adapter` or
`Trusted JavaScript Adapter` Provider. The ready-to-import declarations are in
[`examples/custom-providers`](./examples/custom-providers). Configure the
Provider Base URL separately and enter the write-only secret named by
`secretRef`/`requiredSecrets`; example files never contain secret values or
actual Provider URLs. Run validation, capability preview, redacted request
preview, Dry Run, simulation, and path tests before saving a revision.

Trusted JavaScript installation is administrator-only and is explicitly trusted
server-side code, not a sandbox. Review the exact source digest, host allowlist,
secret names, and resource limits before installation. The worker exposes only
the host-injected `SafeHttpPort`; dynamic imports, package installation, direct
network globals, process access, and unbounded output are rejected or bounded.
All Provider credentials stay server-side, encrypted at rest, excluded from
browser DTOs, logs, PWA caches, and exported configuration.

## License

Imagine Media Studio is licensed under the [MIT License](./LICENSE). Reviewed third-party projects and future attribution requirements are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
