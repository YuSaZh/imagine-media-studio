<div align="center">

<img src="./apps/web/public/icons/app-icon-192.png" alt="Imagine Media Studio" width="80" />

# Imagine Media Studio

**轻量、自托管的图片与视频创作空间**

接入自己的 AI API，从灵感、生成到编辑与收藏，在一个工作区完成。

一个容器 · 无需 GPU · 桌面与手机 · 中 / 英 / 日

[![Release](https://img.shields.io/github/v/release/YuSaZh/imagine-media-studio?style=flat-square)](https://github.com/YuSaZh/imagine-media-studio/releases/latest) [![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/YuSaZh/imagine-media-studio/pkgs/container/imagine-media-studio) [![CI](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-MIT-22a06b?style=flat-square)](./LICENSE)

**简体中文** · [English](./README_EN.md) · [日本語](./README_JA.md)

[功能特色](#features) · [界面预览](#screenshots) · [快速部署](#quick-start) · [文档](#documentation)

</div>

<a id="features"></a>
多选图片、视频或混合选择可合并为持久化系列；系列删除可选择仅删除封面或整个系列。任务列表默认折叠长提示词，失败任务支持删除。

管理员可在偏好中修改网站名称、上传或恢复网站 Logo；移动端长按作品多选，顶部搜索可展开。

## 为创作而设计

| 特色 | 你可以做什么 |
| --- | --- |
| **🎨 图片创作** | 文字生图、参考图编辑、蒙版局部修改，直接在作品上继续创作。 |
| **🎬 视频创作** | 文生视频、首帧与多参考图生成；按模型能力支持编辑、续写和首尾帧。 |
| **🗂️ 作品整理** | 图片与视频统一管理，支持项目、搜索、收藏、批量操作，原图与衍生作品按系列浏览。 |
| **🔌 自选模型** | 接入 OpenAI 兼容、Google Gemini、xAI 或自定义适配器，按项目和模型记住生成参数。 |
| **🌗 轻松切换** | 浅色 / 深色 / 跟随系统，简体中文 / English / 日本語，配合桌面与手机专属布局、平滑过渡和触屏手势。 |
| **🏠 自己掌控** | 单容器 + SQLite，作品保存在自己的服务器；账号数据隔离，API 密钥在服务端加密保存。 |

生成能力取决于模型与上游 API；项目不包含模型或 API 额度，提示词和参考素材会发送给你选择的服务商。详见[模型能力](./docs/model-capabilities.md)。

<a id="screenshots"></a>
## 先看界面

<table>
  <tr><th>桌面工作区</th><th>手机工作区</th></tr>
  <tr>
    <td width="76%"><img src="./e2e/visual-baselines/workspace/workspace-1440x900/workspace.png" alt="桌面工作区" width="100%" /></td>
    <td width="24%"><img src="./e2e/visual-baselines/workspace/workspace-390x844/workspace.png" alt="手机工作区" width="100%" /></td>
  </tr>
</table>

浅色界面示例，使用测试素材；也支持深色主题。

<a id="quick-start"></a>
## 快速部署

准备好 **Docker Compose v2** 即可，支持 **AMD64 / ARM64**。下面的首次安装命令适用于 Bash，需要 `openssl`。

### 1 · 创建目录与初始配置

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

初始账号为 `admin`，随机密码见 `.env` 的 `ADMIN_PASSWORD`。**请保留 `.env` 和 `APP_SECRET`，升级时不要重新生成**，它用于解密已保存的 API 密钥。

### 2 · 保存为 `compose.yaml`

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

### 3 · 启动

```bash
docker compose up -d
```

打开 **http://localhost:3030**（远程部署换成服务器地址）并登录。端口冲突时在 `.env` 添加 `IMAGINE_MEDIA_HOST_PORT=其他端口`。

<a id="providers"></a>
### 接上 API，开始创作

1. **设置 → 连接**：填写接口类型、Base URL 和 API Key。
2. 从目录添加模型，或手动填写模型 ID，确认调用协议与支持的操作。
3. 返回创作页，选择图片或视频，输入描述并生成。

默认使用简体中文和浅色主题，可在 **设置 → 偏好** 切换语言与主题。

OpenAI 兼容接口的 Base URL 通常形如 `https://api.example.com/v1`，不要填完整的 `/chat/completions` 路径。更多接入方式见[自定义适配器示例](./examples/custom-providers/README.md)。

<a id="configuration"></a>
<a id="faq"></a>
<details>
<summary>更多配置与 PWA</summary>

在 `.env` 中添加可选配置，例如 `PUBLIC_BASE_URL` 或内网 API 所需的 `ALLOW_PRIVATE_NETWORK_ACCESS=true`，然后重新创建容器。完整参数见 [.env.example](./.env.example)。对外访问建议使用 HTTPS；PWA 安装通常也需要 HTTPS（本机 `localhost` 除外），离线功能限于已缓存预览和草稿。

</details>

## 更新也很简单

备份数据并保留原 `.env` 与 `data/`，在部署目录执行：

```bash
docker compose pull
docker compose up -d
```

`latest` 跟随稳定版；需要固定版本可使用 `:0.2.1` 或发布页中的镜像 digest。备份、迁移与回滚见[部署指南](./RELEASE.md)；界面中的数据库备份不包含媒体文件。

<a id="development"></a>
<a id="documentation"></a>
## 按需了解更多

- [更新记录](./CHANGELOG.md) · [发布版本](https://github.com/YuSaZh/imagine-media-studio/releases) · [已知限制](./Hold.md)
- [模型能力](./docs/model-capabilities.md) · [部署与数据管理](./RELEASE.md) · [完整文档](./docs/README.md)
- [开发与贡献](./CONTRIBUTING.md) · [问题反馈](https://github.com/YuSaZh/imagine-media-studio/issues)

---

[MIT License](./LICENSE) · 界面与交互参考 Grok Imagine，复用范围见[第三方声明](./THIRD_PARTY_NOTICES.md)与[审计记录](./docs/third-party/reuse-audit.md)。
