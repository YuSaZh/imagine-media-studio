<div align="center">

<img src="./apps/web/public/icons/app-icon-192.png" alt="Imagine Media Studio" width="80" />

# Imagine Media Studio

**A lightweight, self-hosted image and video workspace**

Bring your own AI APIs. Create, edit, and organize your work in one place.

One container · No GPU required · Desktop & mobile · 中文 / English / 日本語

[![Release](https://img.shields.io/github/v/release/YuSaZh/imagine-media-studio?style=flat-square)](https://github.com/YuSaZh/imagine-media-studio/releases/latest) [![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/YuSaZh/imagine-media-studio/pkgs/container/imagine-media-studio) [![CI](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-MIT-22a06b?style=flat-square)](./LICENSE)

[简体中文](./README.md) · **English** · [日本語](./README_JA.md)

[Features](#features) · [Preview](#screenshots) · [Quick start](#quick-start) · [Docs](#documentation)

</div>

<a id="features"></a>
Selected images and videos, including mixed selections, can be merged into a persistent series. Series deletion offers cover-only or whole-series removal. Task lists collapse long prompts by default and support deleting failed tasks.

Administrators can rename the site and upload or reset its logo in Preferences. Mobile galleries support long-press selection and expandable header search.

## Built for creating

| Feature | What you can do |
| --- | --- |
| **🎨 Images** | Generate from text, edit with references or masks, and keep creating directly from a result. |
| **🎬 Video** | Generate from text, a first frame, or multiple references; use editing, extension, and first/last frames where the model supports them. |
| **🗂️ Your library** | Organize images and videos with projects, search, favorites, and bulk actions. Browse originals and derived works as a series. |
| **🔌 Your models** | Connect OpenAI-compatible APIs, Google Gemini, xAI, or custom adapters. Keep generation settings per project and model. |
| **🌗 Your workspace** | Light, dark, or system theme; Chinese, English, and Japanese. Dedicated desktop and mobile layouts with smooth transitions and touch gestures. |
| **🏠 Your server** | One container with SQLite. Store media on your server, isolate account data, and keep API keys encrypted on the server. |

Generation features depend on the model and provider. Models and API credits are not included; prompts and references are sent to your chosen provider. See [model capabilities](./docs/model-capabilities.md).

<a id="screenshots"></a>
## Take a look

<table>
  <tr><th>Desktop workspace</th><th>Mobile workspace</th></tr>
  <tr>
    <td width="76%"><img src="./e2e/visual-baselines/workspace/workspace-1440x900/workspace.png" alt="Desktop workspace" width="100%" /></td>
    <td width="24%"><img src="./e2e/visual-baselines/workspace/workspace-390x844/workspace.png" alt="Mobile workspace" width="100%" /></td>
  </tr>
</table>

Light-theme examples with test media; a dark theme is also available.

<a id="quick-start"></a>
## Quick start

You need **Docker Compose v2**, on **AMD64 or ARM64**. The first-install commands below use Bash and `openssl`.

### 1 · Create a directory and initial configuration

```bash
mkdir imagine-media-studio && cd imagine-media-studio
umask 077
mkdir -m 700 data
(
  set -o noclobber
  printf 'APP_SECRET=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nPUID=%s\nPGID=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" "$(id -u)" "$(id -g)" > .env
)
```

Sign in as `admin` with the random `ADMIN_PASSWORD` in `.env`. **Keep `.env` and the original `APP_SECRET` across upgrades**: it decrypts your saved API keys.

### 2 · Save as `compose.yaml`

```yaml
services:
  imagine-media:
    image: ghcr.io/yusazh/imagine-media-studio:latest
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    ports:
      - "${IMAGINE_MEDIA_HOST_PORT:-3030}:3030"
    env_file: .env
    environment:
      APP_PORT: "3030"
      DATA_DIR: /data
      MOCK_PROVIDER_ENABLED: "false"
    volumes:
      - ./data:/data
```

### 3 · Start

```bash
docker compose up -d
```

Open **http://localhost:3030** (use your server address for a remote deployment) and sign in. To change the host port, add `IMAGINE_MEDIA_HOST_PORT=your-port` to `.env`.

<a id="providers"></a>
### Connect an API and start creating

1. In **Settings → Connections**, enter the provider type, Base URL, and API key.
2. Add a model from the catalog or enter its ID, then confirm its protocol and supported operations.
3. Return to the workspace, choose image or video, enter a prompt, and generate.

The default UI is Simplified Chinese with a light theme. Change both in **设置 → 偏好** (Settings → Preferences); select English under **界面语言**.

An OpenAI-compatible Base URL typically looks like `https://api.example.com/v1`, not the full `/chat/completions` endpoint. See [custom adapter examples](./examples/custom-providers/README.md) for other integrations.

<a id="configuration"></a>
<a id="faq"></a>
<details>
<summary>More configuration and PWA</summary>

Add optional settings to `.env`, such as `PUBLIC_BASE_URL` or `ALLOW_PRIVATE_NETWORK_ACCESS=true` for a private-network API, then recreate the container. See [.env.example](./.env.example) for all options. Use HTTPS for public access; PWA installation generally requires it too (`localhost` is a local exception). Offline support covers cached previews and drafts.

</details>

## Easy updates

Back up your data and keep the existing `.env` and `data/`. From the deployment directory:

```bash
docker compose pull
docker compose up -d
```

`latest` tracks stable releases. Pin `:0.2.2` or the release image digest for a fixed version. See the [deployment guide](./RELEASE.md) for backups, migration, and rollback; database-only backups in the UI do not include media.

<a id="development"></a>
<a id="documentation"></a>
## Explore further

- [Changelog](./CHANGELOG.md) · [Releases](https://github.com/YuSaZh/imagine-media-studio/releases) · [Known limitations](./Hold.md)
- [Model capabilities](./docs/model-capabilities.md) · [Deployment and data](./RELEASE.md) · [All docs](./docs/README.md)
- [Development and contributing](./CONTRIBUTING.md) · [Report an issue](https://github.com/YuSaZh/imagine-media-studio/issues)

---

[MIT License](./LICENSE) · Interface and interactions inspired by Grok Imagine. See [third-party notices](./THIRD_PARTY_NOTICES.md) and the [reuse audit](./docs/third-party/reuse-audit.md).
