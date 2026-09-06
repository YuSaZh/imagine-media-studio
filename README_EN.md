<div align="center">

<img src="./apps/web/public/icons/app-icon-192.png" alt="Imagine Media Studio" width="72" />

# Imagine Media Studio

**A lightweight, self-hosted workspace for AI image and video creation**

Connect your own generation APIs to create, edit, preview, and organize media in one place.<br>
Separate desktop and mobile layouts, deployed as a single container.

[简体中文](./README.md) | **English**

[![CI](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/YuSaZh/imagine-media-studio?style=flat-square)](https://github.com/YuSaZh/imagine-media-studio/releases/latest)
[![License](https://img.shields.io/badge/License-MIT-22a06b?style=flat-square)](./LICENSE)
[![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/YuSaZh/imagine-media-studio/pkgs/container/imagine-media-studio)

[Screenshots](#screenshots) · [Features](#features) · [Quick Start](#quick-start) · [Providers](#providers) · [FAQ](#faq)

</div>

> This project provides a web interface for generation jobs. It does not include model inference or API credits. Real generation requires an external API; prompts and reference media are sent to your chosen provider. Media and jobs are stored on your server, and API keys are encrypted on the server.

<a id="screenshots"></a>
## Screenshots

<details>
<summary><strong>Show desktop and mobile screenshots</strong></summary>

### Desktop

![Desktop creation workspace and masonry gallery](./e2e/visual-baselines/workspace/workspace-1440x900/workspace.png)

### Mobile

<img src="./e2e/visual-baselines/workspace/workspace-390x844/workspace.png" alt="Mobile creation workspace" width="390" />

Screenshots come from this project's automated workspace checks and show uploaded test media. This README describes the current `main` implementation; see the corresponding [changelog](./CHANGELOG.md) for a stable release's feature set. The application currently uses Chinese interface labels; relevant labels are included in the instructions below.

</details>

<a id="features"></a>
## Features

### Image Generation and Editing

- Text-to-image generation, reference-image editing, and masked editing, with file upload, clipboard paste, and drag and drop.
- A built-in mask canvas with brush, eraser, undo, and redo.
- Model-aware aspect ratio, resolution, count, and quality controls; compatible models support custom pixel dimensions.
- Reuse a result as a reference for the next creation, inspect original images, and download originals.

### Video Creation

- Text-to-video, first-frame video, and multi-reference video, depending on the selected model.
- Dedicated desktop controls for video input mode, resolution, and duration, including custom values within model limits.
- Asynchronous job tracking, cancellation, retry, video posters, browser playback, and original downloads.
- Batches become independent jobs so individual failures can be handled separately.

### Connections and Models

- OpenAI / OpenAI-compatible, Google Gemini, xAI, and custom HTTP or trusted JavaScript adapters.
- Multiple models per connection, with per-model protocols, parameter choices, defaults, and locked values.
- Search remote model catalogs or add models manually; identical model IDs on different connections remain distinct.
- Image generation through compatible Chat Completions endpoints, with alternate image protocols attempted after explicit protocol incompatibility errors.

### Workspace and Media Library

- A virtualized masonry gallery for images and videos, with search, type filters, favorites, and batch actions.
- Organize media into projects; new output generated inside a project is added to that project.
- Generation preferences are remembered per account, project, image/video mode, and model.
- Desktop and mobile layouts are maintained separately: desktop has fixed header controls and a scrolling gallery, while mobile retains compact controls and touch interactions.

### Accounts, Data, and PWA

- Administrators can create and disable accounts. Media, jobs, projects, and preferences are private to each account; connections and model catalogs are shared and administrator-managed.
- API keys are encrypted on the server. Configuration exports omit keys and custom request headers.
- Database backups, full-data archives, integrity checks, and repair of missing thumbnails or video posters.
- PWA installation controls, update notifications, and offline previews and draft recovery for authenticated sessions. Generation is unavailable offline.

<a id="quick-start"></a>
## Quick Start

### Deploy with Docker Compose

Requires Docker and Docker Compose v2. Images support `linux/amd64` and `linux/arm64`; no local model or GPU driver is required.

**1. Prepare data and initial configuration in a new deployment directory**

These commands require Bash and `openssl`. Generate `.env` only for the initial deployment:

```bash
mkdir imagine-media-studio
cd imagine-media-studio
umask 077
mkdir -p data
chmod 700 data
(
  set -o noclobber
  printf 'APP_SECRET=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nPUID=%s\nPGID=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" "$(id -u)" "$(id -g)" > .env
)
```

`ADMIN_PASSWORD` in `.env` is the generated initial administrator password. Keep `.env` secure and backed up. Its `APP_SECRET` decrypts stored API credentials and must retain the same value during upgrades and restores; do not regenerate it.

**2. Create `compose.yaml`**

```yaml
services:
  imagine-media:
    image: ghcr.io/yusazh/imagine-media-studio:latest
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    ports:
      - "${IMAGINE_MEDIA_HOST_PORT:-3030}:${APP_PORT:-3030}"
    volumes:
      - ./data:/data
    environment:
      APP_PORT: "${APP_PORT:-3030}"
      DATA_DIR: /data
      APP_SECRET: "${APP_SECRET:?APP_SECRET is required}"
      ADMIN_USERNAME: "${ADMIN_USERNAME:-admin}"
      ADMIN_PASSWORD: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
      MOCK_PROVIDER_ENABLED: "false"
      PUBLIC_BASE_URL: "${PUBLIC_BASE_URL:-}"
      TRUST_PROXY_HOPS: "${TRUST_PROXY_HOPS:-0}"
      ALLOW_INSECURE_PROVIDER_HTTP: "${ALLOW_INSECURE_PROVIDER_HTTP:-false}"
      ALLOW_PRIVATE_NETWORK_ACCESS: "${ALLOW_PRIVATE_NETWORK_ACCESS:-false}"
      ALLOW_HTTP_MEDIA_DOWNLOADS: "${ALLOW_HTTP_MEDIA_DOWNLOADS:-false}"
```

**3. Start and sign in**

```bash
docker compose up -d
```

Open `http://localhost:3030`, replacing `localhost` with your server address when needed. Sign in as `admin` using `ADMIN_PASSWORD` from `.env`. If the host port is occupied, set a different `IMAGINE_MEDIA_HOST_PORT` in `.env`.

Open **Settings > Connections (设置 > 连接)** to add an API, then add or select a model. After initialization, manage credentials under **Settings > Account Management (设置 > 账号管理)**; changing environment variables does not reset existing accounts.

### Image Tags and Updates

| Image tag | Purpose |
| --- | --- |
| `latest` | Most recently published stable release |
| A version such as `0.1.2` | A specific stable release |
| `test` | Most recently validated and published test image |
| `test-sha-<full-commit-SHA>` | A test image associated with a source commit |
| `@sha256:<digest>` | Exact image content for reproducible deployment and rollback records |

For test builds, use `ghcr.io/yusazh/imagine-media-studio:test`. Pushing to `main` triggers CI; a maintainer must also run **Test Image**, which updates `test` only after verification succeeds.

Before upgrading, back up according to the [release and backup guide](./RELEASE.md). Preserve `.env` and the existing data mount, then run these commands from the deployment directory:

```bash
docker compose pull
docker compose up -d
```

A new image takes effect when the container is recreated. Running only `pull` or `restart` does not switch an existing container to the new image. Use a release digest when production deployments require exact image pinning.

<a id="providers"></a>
## Providers and Models

### Supported Protocols

| Connection type | Image protocols | Video protocols |
| --- | --- | --- |
| OpenAI / OpenAI-compatible | Images, Responses Image Tool, Chat Completions Image | Compatible Videos API |
| Google Gemini | Generate Content, Interactions Image | Veo Operations, Omni Interactions Video |
| xAI | Imagine Images | Imagine Videos |
| Custom HTTP | Declarative JSON/YAML requests and response extraction | Declarative asynchronous submission and polling |
| Trusted JavaScript | Administrator-installed server adapters | Defined by the adapter |

These are implemented protocol adapters, not a guarantee that every provider or model supports every feature. Aspect ratios, resolutions, durations, references, masks, cancellation, and batch limits depend on model capabilities and the upstream API.

### Configure Your First Model

1. Add a connection under **Settings > Connections (设置 > 连接)** with its interface type, Base URL, and API key.
2. Check connectivity and select a model from the remote catalog, or enter its complete model ID manually.
3. Review the model protocol and supported operations, then configure parameter rules as needed.
4. Return to the workspace, choose image or video mode and a model, enter a prompt, and submit.

An OpenAI-compatible Base URL commonly includes `/v1`, such as `https://api.example.com/v1`. Follow your provider's documentation, and do not use a complete operation path such as `/chat/completions` as the Base URL.

Identical model names do not imply identical gateway protocols. Some Gemini image models generate through a chat endpoint; select **OpenAI · Chat Completions Image** in that model's configuration. Protocol fallback preserves model parameter constraints and does not blindly regenerate after timeouts, rate limits, or ambiguous failures.

### Public References and Custom Adapters

Configure a public HTTPS domain under **Settings > Account Management (设置 > 账号管理)**, or set `PUBLIC_BASE_URL` as the initial fallback, to use signed reference-image links valid for 15 minutes with supported protocols. Otherwise, references use the protocol's embedded-image or upload mechanism. Whether a compatible gateway can fetch public links depends on its network access.

Manage custom adapters from their connection's adapter page. See [examples/custom-providers](./examples/custom-providers) for examples. Tools include validation, redacted request previews, Dry Run, response-path tests, and revision management. JavaScript adapters are administrator-trusted server code, not a security sandbox.

<a id="configuration"></a>
## Configuration and Data

| Setting | Description |
| --- | --- |
| `APP_SECRET` | Persistent encryption secret; use at least 32 random characters for production |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Initial administrator credentials only; the application defaults to `admin` / `admin`, while the setup above generates a random password |
| `IMAGINE_MEDIA_HOST_PORT` / `APP_PORT` | Compose host port / container port, both `3030` by default |
| `PUID` / `PGID` | Compose runtime user IDs, used to match data-directory ownership |
| `DATA_DIR` | Application data directory; use `/data` inside the container |
| `PUBLIC_BASE_URL` | Public application URL for signed reference links; can be overridden in settings |
| `TRUST_PROXY_HOPS` | Defaults to `0`; use `1` only behind a trusted reverse proxy |
| `MOCK_PROVIDER_ENABLED` | Test Provider switch; disabled in the deployment example above |
| `ALLOW_INSECURE_PROVIDER_HTTP` | Allow HTTP Providers; disabled by default |
| `ALLOW_PRIVATE_NETWORK_ACCESS` | Allow private-network Provider or media addresses; disabled by default |
| `ALLOW_HTTP_MEDIA_DOWNLOADS` | Allow downloading returned media over HTTP; disabled by default |

See [.env.example](./.env.example) for additional upload limits, timeouts, and logging settings. Pass additional settings through the Compose service's `environment` as well.

- **Persistence:** SQLite, media, projects, and jobs live in `/data`, rather than exclusively in browser storage. Devices signed in to the same account can access that account's server data.
- **Backups:** Database backups in the UI do not include images or videos. For full migration, use [offline data archives](./docs/architecture/pr8-data-archive.md), and retain `.env` / `APP_SECRET` separately.
- **Reverse proxy:** Use HTTPS for public access. With `TRUST_PROXY_HOPS=1`, restrict the application port to the trusted proxy and forward `Host` and `X-Forwarded-Proto` correctly. See [RELEASE.md](./RELEASE.md) for operator details.

<a id="development"></a>
## Local Build and Verification

Requires Node.js 24, pnpm `11.23.0`, and FFmpeg available on `PATH`.

```bash
git clone https://github.com/YuSaZh/imagine-media-studio.git
cd imagine-media-studio
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

The following starts a local test instance with temporary data and Mock enabled. Confirm that port `13030` is unused first:

```bash
IMAGINE_DEV_DATA="$(mktemp -d /tmp/imagine-media-dev.XXXXXX)"
APP_PORT=13030 DATA_DIR="$IMAGINE_DEV_DATA" \
  WEB_DIST_DIR="$PWD/apps/web/dist" \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=local-preview-only \
  APP_SECRET="$(openssl rand -hex 32)" MOCK_PROVIDER_ENABLED=true \
  pnpm --filter @imagine/server start
```

Open `http://localhost:13030` and sign in with `admin` / `local-preview-only`. Mock produces test outputs without invoking a real model. Use the Compose setup above for a persistent deployment.

```bash
pnpm run ci
pnpm exec playwright install --with-deps chromium
E2E_PORT=13031 pnpm test:e2e --update-snapshots=none
```

`pnpm run ci` runs lint, type checks, unit tests, and a production build. Browser checks cover eight viewport sizes, workflows, accessibility, and visual baselines. E2E also requires a free port and creates and removes its own temporary data; do not run destructive checks against an existing deployment.

Stack: React 19, TypeScript, Vite, TanStack Query / Virtual, Radix UI, Fastify, SQLite / Drizzle, Sharp, FFmpeg, and Workbox. The application runs as one Node.js app, one SQLite database, one port, and one `/data` mount.

<a id="faq"></a>
## FAQ

**Do I need a GPU or model files?**

No. Inference runs on your chosen API provider. This project manages the interface, jobs, and media. API fees and available credits are determined by that provider.

**Why can generation fail after a successful connection test?**

Connectivity or a working model catalog does not guarantee generation endpoint support, model credits, or valid parameters. Check the model ID, protocol, upstream permissions, and job error details. Do not include real API keys in issues, screenshots, or logs.

**Can I deploy to GitHub Pages or a static-only host?**

The current architecture requires a Node.js server, SQLite, and persistent storage. Uploading only frontend build files is insufficient. Use Docker or run the complete Node.js application.

**Why is PWA installation unavailable, or why can't I generate offline?**

PWA functionality depends on browser support and a secure HTTPS context; `localhost` works for local testing. Offline features cover cached previews and drafts, not model inference. See [Hold.md](./Hold.md) for physical-device verification coverage and other known limitations.

**Why doesn't pulling `test` include a just-merged feature?**

`test` follows successful test-image publications, not every commit. Confirm that the corresponding Test Image workflow succeeded, then pull and recreate the container. An open PWA may also need to accept an update or reload.

<a id="documentation"></a>
## Documentation and Feedback

- [简体中文 README](./README.md)
- [Changelog](./CHANGELOG.md) · [Releases, upgrades, backups, and rollback](./RELEASE.md)
- [Custom Provider examples](./examples/custom-providers) · [Data archives](./docs/architecture/pr8-data-archive.md)
- [Contributing](./CONTRIBUTING.md) · [Project Agent rules](./AGENTS.md) · [Documentation index](./docs/README.md)
- [Workspace design](./docs/design-spec/workspace.md) · [Current architecture](./docs/architecture/overview.md) · [Known limitations](./Hold.md)
- [Report an issue or request a feature](https://github.com/YuSaZh/imagine-media-studio/issues)

Include the application version or image tag, device and browser, reproduction steps, and redacted error details when reporting an issue.

## License and Acknowledgments

Licensed under the [MIT License](./LICENSE).

The interface and interactions are inspired by Grok Imagine. See [third-party notices](./THIRD_PARTY_NOTICES.md) and the [reuse audit](./docs/third-party/reuse-audit.md) for the exact reuse scope and licensing details.
