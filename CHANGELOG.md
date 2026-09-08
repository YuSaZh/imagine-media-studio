# Changelog

All notable changes to Imagine Media Studio are documented in this file.

## [Unreleased]

## [0.1.3] - 2026-09-07

发布日期：2026-09-07 · 上一稳定版：v0.1.2

> 本次更新完善了图片生成的协议兼容和大图处理，统一桌面与手机的生成控件，并修复模型管理中的删除、能力载入和参数覆盖问题。

### 重点更新

- **张数独立于模型：** 使用 `1 / 2 / 4 / 8 / +` 选择生成数量，支持自定义 1–32 个独立生成任务，不再被模型的批量能力、隐藏参数或固定默认值限制。
- **双端统一图片控件：** 手机在图片/视频切换同一行提供画幅、分辨率和张数；两端均使用圆角弹出选择面板，自定义尺寸支持比例锁和 16 像素对齐。
- **兼容更多 Chat 生图返回：** 支持 CPA 结构化图片、New API Markdown 内嵌图片及其流式分片，减少有图片返回却报“无图片结果”的情况。
- **大图处理不再误报协议错误：** 修复大 Base64 图片校验时的栈溢出，保留完整原图和缩略图处理，并区分内部处理失败与模型协议不可用。

以上修复见 [39b4672](https://github.com/YuSaZh/imagine-media-studio/commit/39b4672)。

### 生图与协议兼容

- 已知模型自动匹配对应协议，保留显式覆盖配置；支持经过服务器校验的自定义模型 ID，以及 OpenAI 兼容接口中的 Gemini 别名。([c52cbea](https://github.com/YuSaZh/imagine-media-studio/commit/c52cbea), [8b36c78](https://github.com/YuSaZh/imagine-media-studio/commit/8b36c78))
- 按渠道协议传递原生 `1K / 2K / 4K` 或映射后的像素尺寸；例如 16:9 的 4K 映射为 `3840x2160`，竖向画幅交换宽高。Chat 适配同时提供 CPA 和 New API 所需的图片配置字段。
- 在可明确识别的图片接口不兼容错误下支持 Chat 协议回退，保留原有参数约束；不因超时、限流或不明确的失败盲目重新生成。([2598518](https://github.com/YuSaZh/imagine-media-studio/commit/2598518))
- Base64 使用线性规范校验，在解码前检查大小；已有格式、字节数和像素上限仍然生效。新增超过 10 MiB 的合成图片落盘及 64 MiB 校验边界回归。

### 桌面与移动端

- 桌面图库独立滚动，保持页头和生成栏稳定；视频模式的快捷分辨率、时长与自定义参数可在更多设置中同步修改。([294ba93](https://github.com/YuSaZh/imagine-media-studio/commit/294ba93), [65680a9](https://github.com/YuSaZh/imagine-media-studio/commit/65680a9))
- 分辨率统一为 `auto / 1K / 2K / 4K / 自定义`。关闭自定义尺寸比例锁时，画幅立即切为 `auto`，保留当前尺寸；修改宽高后在失焦或应用时对齐到最近的 16 倍数。模型固定的画幅和分辨率规则仍受保护。
- 原生下拉框改为共享选择卡片，覆盖生成设置、模型与连接管理、偏好、任务筛选和适配器格式。支持键盘导航、选中状态、长文本换行及滚动。
- 生成数量和其他设置继续按账号、项目、图片/视频类型及模型分别记忆。

### 模型管理

- 目录模型可以直接删除，无需先编辑保存；自定义适配器管理的模型仍由适配器定义维护。移除容易覆盖既有编辑的批量“刷新模型”按钮。
- “从模型能力载入”按所选模型协议补全内置能力，保留已编辑的参数和显式配置；修复跨渠道模型能力为空的问题。未识别模型会明确提示手动配置。
- 添加模型时可以搜索远端目录的名称或 ID，并通过键盘选择。

相关提交：[39b4672](https://github.com/YuSaZh/imagine-media-studio/commit/39b4672)。

### 升级说明与限制

- 本版本没有新增数据库迁移，继续使用单容器、SQLite 和持久化 `/data`；升级时保留原有数据、用户权限和 `APP_SECRET`，具体步骤见版本对应的发布指南。
- 张数表示独立任务数量，实际同时执行的数量由服务器队列限制；不等于向上游发送一个多图批量请求。原有模型 `count` 规则不再控制该数量。
- 可用画幅、分辨率和返回的实际图片尺寸仍取决于模型与渠道；Chat 生图仅接受能映射到受支持预设的像素尺寸。自动化 fixture 通过不代表所有真实渠道验收。
- Test Image 支持在主分支 CI 通过后手动发布经过摘要验证的多架构测试镜像，与稳定版本发布及具体部署分开执行。([4047cb2](https://github.com/YuSaZh/imagine-media-studio/commit/4047cb2), [294ba93](https://github.com/YuSaZh/imagine-media-studio/commit/294ba93))

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.2...v0.1.3](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.2...v0.1.3)

## [0.1.2] - 2026-09-06

### Added

- Connected Imagine workspace with responsive generation controls, library
  references, project-scoped assets, and inline generation previews.
- Isolated user accounts with administrator account management, configurable
  public domain, and explicit support for trusted HTTPS reverse proxies.
- Shared provider connections with model-specific protocols and editable
  generation parameter policies.

### Fixed

- Stabilize mobile navigation gestures, scroll boundaries, and video controls.
- Correct image MIME inference, custom dimensions, and provider catalog errors.
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
