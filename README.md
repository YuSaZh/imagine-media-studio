<div align="center">

<img src="./apps/web/public/icons/app-icon-192.png" alt="Imagine Media Studio" width="72" />

# Imagine Media Studio

**一个轻量、自托管的 AI 图片与视频创作工作台**

接入自己的生成 API，在同一个工作区完成创作、编辑、预览与作品管理。<br>
独立桌面与移动布局，一个容器即可部署。

**简体中文** | [English](./README_EN.md)

[![CI](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/YuSaZh/imagine-media-studio?style=flat-square)](https://github.com/YuSaZh/imagine-media-studio/releases/latest)
[![License](https://img.shields.io/badge/License-MIT-22a06b?style=flat-square)](./LICENSE)
[![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/YuSaZh/imagine-media-studio/pkgs/container/imagine-media-studio)

[界面预览](#screenshots) · [核心功能](#features) · [快速部署](#quick-start) · [接入模型](#providers) · [常见问题](#faq)

</div>

> 本项目提供生成任务的 Web 界面，不包含模型推理服务或 API 额度。真实生成需要自行配置可用的外部 API；提示词和参考素材会发送给你选择的服务商。作品与任务保存在你部署的服务器上，API 密钥由服务端加密保存。

<a id="screenshots"></a>
输入框随内容增高，桌面最多五行、移动端最多四行；移动端失焦收起为两行。应用不再使用运行锁文件，离线归档前由操作者停服。

桌面端点击左侧 Logo 可原位展开导航与项目边栏，主内容随之让位。

## 界面预览

<details>
<summary><strong>展开桌面端与移动端截图</strong></summary>

### 桌面端

![桌面端创作工作区与瀑布流](./e2e/visual-baselines/workspace/workspace-1440x900/workspace.png)

### 移动端

<img src="./e2e/visual-baselines/workspace/workspace-390x844/workspace.png" alt="移动端创作工作区" width="390" />

截图来自本项目工作区的自动化验收，图中媒体为测试上传素材。README 展示 `main` 的当前实现；稳定版的功能范围以对应版本的 [更新记录](./CHANGELOG.md) 为准。

</details>

<a id="features"></a>
## 核心功能

### 图片生成与编辑

- 瀑布流先显示占位卡片，再按真实尺寸逐张显示缩略图；优先加载最近且当前可见的作品，屏幕外缩略图滚动进入可见区域后才请求，慢图或失败图片不阻塞其他作品。

- 文字生图、参考图编辑与蒙版局部编辑，支持上传、粘贴和拖入图片。
- 内置蒙版画布，提供画笔、橡皮擦、撤销与重做。
- 按模型能力选择画幅、分辨率、质量等参数；兼容模型可使用自定义像素尺寸。
- 添加模型时，选择可识别的目录模型会自动载入完整能力和参数规则；未知模型可复制内置模型模板或已有模型配置，保留目标模型的 ID、名称及连接。
- 瀑布流滚动超过 600px 后显示返回顶部按钮，双端自动避让输入框；登录名保持空白，支持浏览器自动填充。
- 内建 MAI-Image、Seedream 和 Seedance 的兼容渠道能力模板；按已核实型号配置图片生成/编辑和视频生成/单首帧输入，不默认启用官方专用功能。
- 图片详情页可原地编辑和生成，支持展开式输入框、桌面滚轮缩放及本次结果继续编辑。支持图片输入的模型均可使用蒙版：原生传递独立蒙版，其余合成半透明遮罩；视频首帧使用干净原图。
- 视频详情页同样支持浮动输入框和原地编辑/续写；切换到生图后仍可拖动视频，仅打开蒙版或发送时截取当前帧；临时帧不进入资源库，任务结束后自动清理，无需额外播放器或前端解码组件。
- 生成卡片实时显示已过秒数，完成后在模型名称旁显示简短用时；添加模型目录隐藏当前连接已有的模型，删除后恢复可选。
- 已识别模型在添加目录中高亮置顶；支持的模型和限制见[模型能力表](./docs/model-capabilities.md)。媒体卡片可直接复制完整提示词。移动端卡片操作使用无底色、无背景模糊的图标；输入框聚焦保持高度，双端生成设置统一控件外观。
- 双端生成数量使用 1 / 2 / 4 / 8 和加号自定义（1–32）；数量表示独立单张任务，不受模型批量能力或参数规则限制，生成提交和上游轮询不设应用级并发上限，由 API 上游控制；下载和本地处理仍使用有界队列。
- 双端图片分辨率提供 auto / 1K / 2K / 4K / 自定义弹出选项；自定义尺寸支持画幅比例锁，关闭锁时画幅切为 auto 并保留尺寸；失焦或应用时对齐到最近的 16 像素倍数，auto 画幅不联动宽高。
- 全站选择控件使用统一圆角弹出面板；双端画幅选项按数量均衡分行。
- 移动端生成设置提供 auto / 1K / 2K / 4K / 自定义分辨率，与桌面共用画幅映射和模型限制。
- 手机图片生成栏在图片/视频切换同一行提供画幅、分辨率、张数三个快捷按钮，沿用桌面样式并与更多设置同步。
- 连接设置不再批量刷新模型；目录模型可直接删除，添加模型使用只读目录，载入能力按模型协议补全并保留已编辑参数。
- 支持分辨率档位的通道直接传档位；仅支持像素尺寸的模型按明确画幅映射，4K 最长边为 3840，边长对齐到最近的 16 倍数，例如 16:9 + 4K 为 3840x2160。auto 不映射为正方形：原生档位可搭配自动画幅，像素档位需先选画幅。Chat 通道兼容转换可映射的旧像素尺寸，实际输出尺寸及限制由模型决定。
- auto 画幅下点击像素分辨率档位，会弹出可用画幅选择，选定后一起应用；GPT Image 2 的标准画幅中，4K 支持 16:9 和 9:16，其余组合受总像素上限限制。
- 分辨率交互由模型能力配置决定：允许的原生档位可直接搭配 auto 画幅；像素尺寸按画幅映射。模型编辑中可配置参数类型、允许值、自定义尺寸和边长/像素限制，未知或自定义模型也可添加新的原生档位。旧配置保留已声明的允许值，不自动扩展档位；前后端共用校验，任务保存提交时的能力快照。
- Chat 生图兼容 CPA 的结构化图片和 New API 的 Markdown 内嵌图片（含流式返回），并适配两者不同的画幅与分辨率参数位置。
- 作品可直接加入参考图，继续下一轮创作；支持原图查看与下载。

### 视频创作

- 支持文生视频、首帧视频和多参考图视频，具体模式由接入模型决定。
- 支持有相应能力的模型进行视频编辑、续写及首尾帧生成；按操作校验视频来源、有效期、时长和参数，新结果独立保存。
- 桌面端提供独立的视频模式、分辨率和时长快捷控件，支持模型允许范围内的自定义值。
- 跟踪异步任务进度，提供取消、重试、视频封面、在线播放和原文件下载。
- 批量生成拆分为独立任务，单个任务失败可单独处理。

### 连接与模型管理

项目菜单支持“设为隐私项目”：内容不显示在首页最近创作和全部作品中，生成占位也从首页隐藏，项目列表使用模糊封面；进入项目后正常查看，可随时取消隐私。图片/视频胶囊按钮的整个区域均可点击切换。

- 接入 OpenAI / OpenAI 兼容、Google Gemini、xAI，以及自定义 HTTP / 可信 JavaScript 适配器。
- 一个连接可管理多个模型，每个模型可指定调用协议、参数选项、默认值和固定参数。
- 支持远端模型目录搜索与手动添加模型，区分不同连接下的同名模型。
- 支持通过 Chat Completions 生图的兼容接口；图片请求遇到明确的协议不兼容错误时，可自动尝试其他兼容协议。

### 工作区与作品管理

- 图片与视频统一进入虚拟瀑布流，支持搜索、类型筛选、收藏和批量操作。
- 编辑器以系列展示原图与衍生图片、视频，生成中状态在主区域显示，缩略图位于输入框上方；失败任务支持复制提示词。
- 偏好支持按系列合并作品并显示数量角标，封面可选最近查看、最新生成或最初原图；子选项“并发生图作为系列显示”可合并同一次提交的多张图片（需有批次记录，支持重试与刷新恢复）。编辑器生成中仅显示状态与计时。
- 首页数据与可见图片优先加载，完成后再利用空闲时间逐个预加载编辑模块；历史事件触发的重复刷新会合并，避免请求堵塞；桌面作品信息使用加宽浮层，不挤压图片。详情标题固定、滚动条隐藏；长提示词按详情卡片最大高度显示可容纳的行数，其余可展开查看，展开与收起不改变卡片大小，并显示生成耗时。手机详情约占屏幕高度 70% 时封顶，点击外部关闭。登录检查不再显示独立过渡页。
- 编辑器支持桌面跨作品连续浏览、手机横滑系列内/竖滑入口间切换；最近查看逐次保存并即时更新封面，单张作品不显示系列缩略条。
- 手机编辑器采用悬浮返回键与工具条、更小的系列缩略图；左右及上下浏览时当前作品和相邻作品同步跟手滑动，未聚焦时隐藏缺少模型提示。
- 使用项目组织作品，在项目中生成的新作品自动归入当前项目。作品菜单支持移动到指定项目；删除项目默认保留作品，可勾选同时删除项目内文件。
- 按账号、项目、图片/视频模式和模型记住生成配置。
- 桌面端与移动端分别维护布局：桌面端固定顶部工具区、独立滚动画廊；移动端保留紧凑输入区与触屏交互。

### 账号、数据与 PWA

- 管理员可创建、停用账号；各账号的作品、任务、项目和偏好相互隔离，连接与模型目录由管理员统一管理。
- API 密钥在服务端加密保存，配置导出不包含密钥和自定义请求头。
- 支持数据库备份、完整数据归档、完整性检查和缺失缩略图/视频封面的修复。
- 提供 PWA 安装入口、更新提示，以及已登录会话下的离线预览和草稿恢复。离线时不提交生成任务。

<a id="quick-start"></a>
- 手机端主编辑器隐藏翻页按钮，通过滑动或系列缩略图切换作品，支持从左侧边缘向右滑动退出；放大和双指操作仍用于图片缩放，退出不会取消生成任务。

- 项目内编辑器支持完整的项目与素材 ID，模型参数记忆可正常保存；同账号已打开页面通过事件同步偏好。系列分组复用一次计算的来源关系，避免长编辑链重复查询。

- 网页登录与 HTTP Basic 共用密码尝试限流，超限返回 `429` 和 `Retry-After`；正常 Cookie 会话不计入密码尝试。

## 快速部署

### Docker Compose 部署

需要 Docker 和 Docker Compose v2。镜像支持 `linux/amd64` 与 `linux/arm64`；无需部署本地模型或安装 GPU 驱动。

**1. 在新的部署目录中准备数据和初始配置**

以下命令适用于 Bash 环境，并需要 `openssl`。只在首次部署时生成 `.env`：

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

`.env` 中的 `ADMIN_PASSWORD` 是随机生成的初始管理员密码。请妥善保存 `.env`；其中的 `APP_SECRET` 用于解密已保存的 API 密钥，后续升级和恢复时必须保留原值，不要重新生成。

**2. 创建 `compose.yaml`**

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
      ALLOW_INSECURE_PROVIDER_HTTP: "${ALLOW_INSECURE_PROVIDER_HTTP:-true}"
      ALLOW_PRIVATE_NETWORK_ACCESS: "${ALLOW_PRIVATE_NETWORK_ACCESS:-false}"
      ALLOW_HTTP_MEDIA_DOWNLOADS: "${ALLOW_HTTP_MEDIA_DOWNLOADS:-true}"
```

**3. 启动并登录**

```bash
docker compose up -d
```

访问 `http://localhost:3030`，或将 `localhost` 换成服务器地址。用户名为 `admin`，密码见 `.env` 中的 `ADMIN_PASSWORD`。若宿主机端口已占用，在 `.env` 中设置其他 `IMAGINE_MEDIA_HOST_PORT`。

登录后打开 **设置 > 连接** 添加 API，再添加或选择模型，即可开始创作。初始化后请在 **设置 > 账号管理** 修改账号信息；修改环境变量不会重置已有账号。

### 镜像版本与更新

| 镜像标签 | 用途 |
| --- | --- |
| `latest` | 最近发布的稳定版本 |
| `0.1.4` 等版本号 | 固定某个稳定版本 |
| `test` | 最近一次通过验证并发布的测试镜像 |
| `test-sha-<完整提交 SHA>` | 按源码提交区分的测试镜像 |
| `@sha256:<摘要>` | 固定镜像内容，用于可重复部署与回滚记录 |

需要测试版时，将 `image` 改为 `ghcr.io/yusazh/imagine-media-studio:test`。`main` 的代码推送只会触发 CI；维护者还需运行 **Test Image** 工作流，验证通过后才会更新 `test`。

日常修改只运行受影响模块和行为的相关测试。正式发版前，必须先对准备发布的最终源码通过本地完整 CI，包括质量检查、全量八视口浏览器测试和隔离 Docker 验证，再将发版提交推送到 GitHub `main` 并推送对应的 `vX.Y.Z` 标签，无需另等远程分支 CI。标签工作流自动执行质量检查和八视口浏览器测试，再构建一次 AMD64/ARM64 候选镜像；按固定摘要完成容器验证后，直接将同一镜像发布为版本标签及 `latest`，并创建 GitHub Release。完整步骤见[发版指南](./RELEASE.md#stable-releases)。

升级前先按 [备份与升级指南](./RELEASE.md) 备份数据，保留原 `.env` 和数据挂载，然后在部署目录执行：

```bash
docker compose pull
docker compose up -d
```

拉取镜像后需要重新创建容器才会生效，单独执行 `pull` 或 `restart` 不会让旧容器切换镜像。生产环境需要精确锁定版本时，使用发布记录中的镜像摘要。

<a id="providers"></a>
## 接入模型

### 支持的协议

| 接口类型 | 图片协议 | 视频协议 |
| --- | --- | --- |
| OpenAI / OpenAI 兼容 | Images、Responses Image Tool、Chat Completions Image | 兼容 Videos API |
| Google Gemini | Generate Content、Interactions Image | Veo Operations、Omni Interactions Video |
| xAI | Imagine Images | Imagine Videos |
| 自定义 HTTP | 声明式 JSON/YAML 请求、响应提取 | 支持声明异步提交与轮询 |
| 可信 JavaScript | 管理员安装的服务端适配器 | 取决于适配器实现 |

上表表示已实现的协议适配，不代表每个服务商或模型都支持全部功能。画幅、分辨率、时长、参考图、蒙版、取消和批量限制，以模型能力及上游接口为准。

### 第一次配置

1. 在 **设置 > 连接** 添加连接，填写接口类型、Base URL 和 API Key。
2. 检查连接，在远端目录中选择模型，或手动填写完整模型 ID。
3. 核对模型调用协议和支持的操作，按需展开默认折叠的“生成参数”设置参数规则。编辑区隐藏滚动条，底部保存按钮始终可见。
4. 返回创作页，选择图片或视频、模型，输入描述并提交。

OpenAI 兼容连接的 Base URL 通常包含 `/v1`，例如 `https://api.example.com/v1`；请以服务商说明为准，不要把 `/chat/completions` 等完整操作路径当成 Base URL。

模型名称相同，不代表网关开放的协议相同。例如，一些 Gemini 图片模型通过聊天接口提供生成能力，可在模型配置中选择 **OpenAI · Chat Completions Image**。协议回退不会绕过模型参数限制，也不会因超时、限流或不明确的失败盲目重新生成。

### 公网参考图与自定义适配器

在 **设置 > 账号管理** 配置公网 HTTPS 域名，或通过 `PUBLIC_BASE_URL` 提供初始值，可让支持的协议使用 15 分钟有效的签名参考图链接。未配置时使用对应协议支持的内嵌图片或上传方式。兼容网关是否能抓取链接，由其网络环境决定。

自定义适配器入口位于连接的适配器管理页，示例见 [examples/custom-providers](./examples/custom-providers)。支持校验、脱敏请求预览、Dry Run、响应路径测试及版本管理。JavaScript 适配器属于管理员信任的服务端代码，不是安全沙箱。

<a id="configuration"></a>
## 配置与数据

| 配置项 | 说明 |
| --- | --- |
| `APP_SECRET` | 长期保留的加密密钥，生产部署建议至少 32 个随机字符 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 仅首次启动时创建管理员；应用默认值为 `admin` / `admin`，上面的部署步骤会生成随机密码 |
| `IMAGINE_MEDIA_HOST_PORT` / `APP_PORT` | Compose 宿主机端口 / 容器内端口，默认均为 `3030` |
| `PUID` / `PGID` | Compose 容器运行用户，用于匹配数据目录权限 |
| `DATA_DIR` | 应用数据路径，容器中使用 `/data` |
| `PUBLIC_BASE_URL` | 公网应用地址，供签名参考图链接使用；可在界面中覆盖 |
| `TRUST_PROXY_HOPS` | 默认 `0`；仅在受信任的反向代理后设为 `1` |
| `MOCK_PROVIDER_ENABLED` | 测试 Provider 开关，默认 `false`；只有显式设为 `true` 才启用。关闭后隐藏历史 Mock 连接和模型，已有素材、任务记录保留 |
| `ALLOW_INSECURE_PROVIDER_HTTP` | HTTP 内容开关的首次初始化值之一，默认开启 |
| `ALLOW_PRIVATE_NETWORK_ACCESS` | 允许访问内网 Provider 或媒体地址，默认关闭 |
| `ALLOW_HTTP_MEDIA_DOWNLOADS` | HTTP 内容开关的首次初始化值之一，默认开启 |

管理员可在「设置 → 偏好」中切换「是否允许 HTTP 内容」，同时控制提供商请求和返回媒体下载，保存后立即生效并跨重启保留。首次初始化默认允许；兼容旧配置时，上述两个 HTTP 环境变量任一为 `false` 则初始化为关闭，之后以数据库保存的开关为准。HTTP 不加密传输；私网与云元数据地址保护仍独立生效。

其他上传大小、超时和日志参数见 [.env.example](./.env.example)。使用其他参数时，也要将其传入 Compose 服务的 `environment`。

- **持久化：** SQLite、媒体、项目和任务放在 `/data`，不是仅保存在浏览器里。多台设备登录同一账号可访问该账号的服务器数据。
- **备份：** 界面中的数据库备份不包含图片和视频；完整迁移使用 [离线数据归档](./docs/architecture/pr8-data-archive.md)，并单独保管 `.env` / `APP_SECRET`。
- **反向代理：** 对外使用 HTTPS。若启用 `TRUST_PROXY_HOPS=1`，限制应用端口只能被代理访问，并正确转发 `Host`、`X-Forwarded-Proto`。详细示例与边界见 [RELEASE.md](./RELEASE.md)。

<a id="development"></a>
## 本地构建与验证

需要 Node.js 24、pnpm `11.23.0`，以及可通过 `PATH` 调用的 FFmpeg。

```bash
git clone https://github.com/YuSaZh/imagine-media-studio.git
cd imagine-media-studio
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

以下启动方式使用独立临时数据和 Mock Provider，适合本地验证。请先确认 `13030` 未被占用：

```bash
IMAGINE_DEV_DATA="$(mktemp -d /tmp/imagine-media-dev.XXXXXX)"
APP_PORT=13030 DATA_DIR="$IMAGINE_DEV_DATA" \
  WEB_DIST_DIR="$PWD/apps/web/dist" \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=local-preview-only \
  APP_SECRET="$(openssl rand -hex 32)" MOCK_PROVIDER_ENABLED=true \
  pnpm --filter @imagine/server start
```

访问 `http://localhost:13030`，使用 `admin` / `local-preview-only` 登录。Mock 仅产生测试输出，不调用真实模型。需要持久部署时请使用前面的 Compose 配置。

```bash
pnpm run ci
pnpm exec playwright install --with-deps chromium
E2E_PORT=13031 pnpm test:e2e --update-snapshots=none
```

`pnpm run ci` 包含 lint、类型检查、单元测试与生产构建。浏览器验收覆盖 8 种视口、功能交互、无障碍和视觉基线。E2E 同样需要未占用的端口，并会创建、清理自己的临时数据；不要针对已有部署运行破坏性测试。

技术栈：React 19、TypeScript、Vite、TanStack Query / Virtual、Radix UI、Fastify、SQLite / Drizzle、Sharp、FFmpeg、Workbox。运行边界为一个 Node.js 应用、一个 SQLite 数据库、一个端口和一个 `/data` 挂载。

<a id="faq"></a>
## 常见问题

**需要 GPU 或模型文件吗？**

不需要。推理由接入的 API 服务商完成，本项目负责界面、任务和媒体管理。API 费用及可用额度由服务商决定。

**连接测试通过，为什么仍不能生成？**

连接或模型目录可用不代表生成接口、模型额度和参数都可用。请核对模型 ID、调用协议、上游权限及任务错误详情；不要将真实 API Key 放进 Issue、截图或日志。

**可以部署到 GitHub Pages 或纯静态托管平台吗？**

当前架构需要 Node.js 服务端、SQLite 和持久化数据目录，不能只上传前端构建文件。推荐 Docker，或运行完整的 Node.js 应用。

**为什么手机上没有安装入口，或离线不能生成？**

PWA 依赖浏览器支持与 HTTPS 安全上下文，`localhost` 可用于本地测试。离线功能用于已缓存的预览和草稿，不提供离线模型推理。具体真机验证范围及其他已知限制见 [Hold.md](./Hold.md)。

**为什么拉取 `test` 后没有出现刚合并的功能？**

`test` 只跟随成功完成的测试镜像发布，不自动跟随每次提交。确认对应 Test Image 工作流已成功，然后重新拉取并创建容器；PWA 已打开的页面还可能需要接受更新或刷新。

<a id="documentation"></a>
## 文档与反馈

- [English README](./README_EN.md)
- [更新记录](./CHANGELOG.md) · [发布、升级、备份与回滚](./RELEASE.md)
- [自定义 Provider 示例](./examples/custom-providers) · [数据归档](./docs/architecture/pr8-data-archive.md)
- [贡献指南](./CONTRIBUTING.md) · [Agent 项目规范](./AGENTS.md) · [文档索引](./docs/README.md)
- [工作区设计](./docs/design-spec/workspace.md) · [当前架构](./docs/architecture/overview.md) · [已知限制](./Hold.md)
- [提交问题或功能建议](https://github.com/YuSaZh/imagine-media-studio/issues)

反馈问题时请附上应用版本或镜像标签、设备与浏览器、复现步骤，以及脱敏后的错误信息。

## 许可证与致谢

本项目采用 [MIT License](./LICENSE)。

界面与交互参考 Grok Imagine。具体复用范围和许可证说明见 [第三方声明](./THIRD_PARTY_NOTICES.md) 与 [复用审计](./docs/third-party/reuse-audit.md)。
