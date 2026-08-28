# Imagine Media Studio 开发计划书

> 文档版本：v3.0（Grok Imagine UI First / 单容器版）<br>
> 日期：2026-08-24<br>
> 目标执行者：Codex 及后续维护者<br>
> 本文档完全替代此前 v1、v2 计划。

---

## 0. 本次修订的核心结论

本项目不再以 `gpt_image_playground` 的页面、组件树或视觉体系作为前端起点。

最终原则是：

1. **Grok Imagine 是唯一 UI/UX Source of Truth。**
2. **前端 App Shell 按 Grok Imagine 重新实现。**
3. **`gpt_image_playground` 仅作为图片功能代码捐赠者。**
4. **先用 Mock 数据完成桌面端和手机端高保真 UI，再接入真实生成能力。**
5. **运行形态仍为一个 Docker 容器、SQLite、同容器内 JobRunner、PWA。**
6. **所有生成能力来自用户已经拥有的外部 API，本项目不提供模型推理服务。**

严禁把本项目做成“GPT Image Playground 换一套深色皮肤”。

---

## 1. 项目定义

### 1.1 产品定位

Imagine Media Studio 是一个面向个人或小范围自托管使用的多媒体生成 WebUI。

用户已经拥有以下一种或多种外部服务：

- OpenAI 或 OpenAI-compatible 图片/视频 API；
- Google Gemini 原生 API；
- xAI/Grok Imagine API；
- 其他第三方图片或视频生成 API；
- 自建中转、聚合网关或内部生成服务。

本项目负责：

- 提供接近当前 Grok Imagine 的高质量桌面和手机 WebUI；
- 统一接入和管理不同 Provider；
- 完成图片生成、图片编辑、文生视频、图生视频等操作；
- 管理提示词、参考图、参数、生成任务、历史和结果；
- 将生成结果保存到本地持久化目录；
- 支持自定义请求模板和受信任请求脚本；
- 使用一个 Docker 容器部署；
- 首发即可安装为 PWA；
- 为未来 Electron 客户端保留复用同一前端的能力。

### 1.2 不属于本项目的内容

首发不建设：

- 模型推理服务；
- GPU 调度；
- PostgreSQL；
- Redis；
- 独立数据库容器；
- 独立 Worker 容器；
- 独立 Nginx 容器；
- Kubernetes；
- 微服务；
- 多租户计费平台；
- 复杂组织、RBAC、额度售卖和渠道分发；
- Electron 客户端。

---

## 2. 不可违背的产品原则

### 2.1 UI 优先级

优先级从高到低为：

1. Grok Imagine 的信息架构、布局和交互；
2. 本项目新增能力对该交互模型的自然扩展；
3. 可访问性、性能和响应式适配；
4. 开源捐赠代码的复用便利性。

任何旧代码只要妨碍 UI 高保真，应当重构或放弃，不得为了“少改代码”改变产品界面。

### 2.2 功能和视觉分别验收

以下两项必须分别通过：

- 功能是否正确；
- UI 是否高保真。

“可以生成图片”不能替代“界面达到 Grok Imagine 目标”；“长得像”也不能替代任务恢复、持久化和错误处理。

### 2.3 轻量自托管优先

默认用户画像：

- 单用户；
- 一台长期运行的家用服务器或 VPS；
- 低到中等并发；
- 生成任务主要由远程 API 执行；
- 希望数据简单备份、升级和迁移。

因此：

- 一个业务容器；
- 一个端口；
- 一个 `/data` 持久化目录；
- SQLite；
- 同容器内任务调度；
- 不引入平台级基础设施。

---

## 3. Grok Imagine UI 复刻策略

### 3.1 唯一 UI/UX 基准

UI 和交互的唯一基准是：

```text
https://grok.com/imagine
```

“复刻”在本项目中的定义是：

- 高保真复现页面信息架构；
- 高保真复现关键区域的尺寸比例和空间关系；
- 高保真复现画廊、Composer、菜单、Viewer 和生成状态的交互；
- 高保真复现桌面到手机的响应式变化；
- 高保真复现动效节奏和反馈方式；
- 不复制 Grok 名称、Logo、品牌专用素材、专有插画或原始图标文件。

项目必须使用自己的：

- 产品名称；
- Logo；
- 图标资源；
- 默认演示素材；
- Design Token 文件；
- 品牌文案。

### 3.2 冻结 UI 参考版本

Grok Imagine 会持续更新，因此开发开始时必须冻结一份参考版本。

仓库记录：

```text
UI_REFERENCE_DATE=2026-08-24
UI_REFERENCE_TARGET=https://grok.com/imagine
```

后续 Grok 更新不自动改变当前迭代目标。要跟进新 UI，必须建立新的参考版本并单独评审。

### 3.3 私有截图参考包

Grok Imagine 是动态登录态应用。为了避免 Codex 凭印象实现，需要建立私有参考包：

```text
.design-reference/
├── grok-imagine-2026-08-24/
│   ├── desktop/
│   ├── tablet/
│   ├── mobile/
│   ├── video/
│   └── notes/
└── README.local.md
```

`.design-reference/` 默认加入 `.gitignore`，避免把登录态截图、用户内容或第三方素材提交到公开仓库。

仓库中只提交由截图推导出的规格：

```text
docs/design-spec/
├── ui-reference-version.md
├── screen-matrix.md
├── information-architecture.md
├── interaction-map.md
├── responsive-map.md
├── geometry.md
├── tokens.md
├── motion.md
└── visual-diff-policy.md
```

### 3.4 必须采集的参考状态

#### 桌面端

- 首次进入/空画廊；
- 有历史内容的主画廊；
- 左侧导航展开和收起状态；
- 图片模式 Composer；
- 视频模式 Composer；
- 比例/模式/模型选择弹层；
- 上传参考图后的 Composer；
- 单图生成中；
- 多图生成中；
- 视频生成中；
- 失败和拒绝状态；
- 图片 Viewer；
- 视频 Viewer；
- 图片编辑入口；
- 图片转视频入口；
- Saved/收藏页；
- 文件夹或集合页；
- 多选状态；
- 加载更多状态；
- 断网或接口错误状态。

#### 手机端

- 主画廊；
- Composer 收起；
- Composer 输入中；
- 软键盘弹出；
- 参考图横向条；
- 参数 Bottom Sheet；
- 图片/视频切换；
- 图片 Viewer；
- 视频 Viewer；
- 长按多选；
- PWA standalone 模式；
- iPhone 安全区；
- Android 安装后窗口。

### 3.5 参考视口

至少保存并测试：

```text
1920 × 1080  桌面宽屏
1440 × 900   常用桌面
1280 × 800   小型笔记本
1024 × 1366  平板竖屏
834  × 1194  平板竖屏
430  × 932   大屏手机
390  × 844   常见手机
360  × 800   小屏手机
```

### 3.6 高保真验收等级

本项目目标为 L3，关键主界面争取 L4：

- L0：只有深色主题；不合格。
- L1：大致有侧栏、画廊和输入框；不合格。
- L2：信息架构相近，但尺寸、状态和手机交互差异明显；不合格。
- L3：几何、层级、交互和响应式高度接近；首发最低要求。
- L4：稳定区域视觉差异很小，动效和边缘状态也基本一致；核心页面目标。

### 3.7 视觉回归阈值

使用固定 Mock 素材和固定字体环境生成基线截图。

验收建议：

- 核心稳定区域像素差异不高于 2%；
- 动态媒体区域使用遮罩排除；
- 关键几何尺寸误差原则上不超过 4px；
- 圆角、间距和控件高度误差原则上不超过 3px；
- 手机安全区和 Composer 底部位置必须逐设备确认；
- 所有关键交互路径必须与 `interaction-map.md` 一致。

数字不是用来追求机械的像素崇拜，而是防止“换成黑色就算复刻”。

---

## 4. 开源项目使用策略

### 4.1 新建干净仓库，不直接 Fork UI

建议创建新的干净仓库：

```text
Imagine Media Studio
```

不得直接把 `gpt_image_playground` 的 `App.tsx`、页面布局和全局 Store 当成项目骨架。

可以将参考项目添加为只读 Git Remote：

```bash
git remote add donor-gpt-image https://github.com/CookSleep/gpt_image_playground.git
git remote add reference-ima2 https://github.com/lidge-jun/ima2-gen.git
git remote add reference-sora https://github.com/alasano/sora-2-playground.git
```

这些 Remote 只用于审查和选择性移植，不用于保持 UI 上游兼容。

### 4.2 `gpt_image_playground` 的正确角色

角色：**图片功能代码捐赠者**。

优先审查和移植：

- OpenAI Images API 请求构造；
- OpenAI Responses API 图片生成逻辑；
- OpenAI-compatible 返回兼容处理；
- 图片编辑请求；
- 多参考图输入；
- 拖放、选择和剪贴板上传；
- 图片压缩、缩放和格式预处理；
- Mask 编辑器的内部算法与画布操作；
- Base64、URL、Blob 和流式结果解析；
- 自定义 HTTP Provider 的声明式映射思想；
- Mock API；
- 单元测试用例；
- 错误归一化经验。

明确禁止直接复用为视觉基础：

- 原 App Shell；
- 原主页面布局；
- 原导航栏；
- 原 Composer；
- 原画廊卡片；
- 原 Viewer；
- 原 CSS Design Token；
- 原响应式结构；
- 原页面级状态组织；
- 原大体量全局 Store。

### 4.3 移植流程

任何移植必须先记录在：

```text
docs/third-party/reuse-audit.md
```

记录字段：

- 上游仓库；
- 上游 commit SHA；
- 上游文件；
- 原许可证；
- 目标文件；
- 复制、改写或仅参考；
- 主要修改；
- 相关测试；
- 是否保留版权头。

禁止一次性复制整个 `src/` 后再慢慢删除。

### 4.4 其他参考项目

#### `lidge-jun/ima2-gen`

只参考：

- Provider Registry；
- 图片和视频统一任务抽象；
- SSE 事件复用；
- 异步视频状态；
- 本地媒体元数据；
- 多 Provider 能力描述。

不采用其完整产品结构、OAuth、CLI、MCP、节点工作流或 UI。

#### `alasano/sora-2-playground`

只参考：

- 异步视频提交；
- 远程任务 ID；
- 多任务排队；
- 刷新后恢复轮询；
- 视频播放器；
- 历史和失败状态。

不把产品绑定到 Sora。

### 4.5 许可证

首发必须包含：

```text
LICENSE
THIRD_PARTY_NOTICES.md
docs/third-party/reuse-audit.md
```

新项目许可证由项目所有者决定；若复用 MIT 代码，必须保留对应版权和许可信息。

---

## 5. 最终部署架构

### 5.1 一个容器

```text
┌──────────────────────────────────────────┐
│ Browser / Installed PWA                  │
└───────────────────┬──────────────────────┘
                    │ HTTP + SSE
┌───────────────────▼──────────────────────┐
│ One Docker Container                     │
│                                          │
│ Node.js App Server                       │
│ ├─ 提供 React/Vite 构建产物              │
│ ├─ 保存 Provider 配置和密钥              │
│ ├─ 调用用户已有的外部 API                │
│ ├─ 同进程 JobRunner                      │
│ ├─ 异步视频轮询                          │
│ ├─ 上传、下载和媒体处理                  │
│ ├─ SSE 状态推送                          │
│ └─ 自定义 Adapter 运行环境               │
│                                          │
│ SQLite: /data/app.db                      │
│ Media:  /data/media                       │
│ Custom: /data/adapters                    │
└───────────────────┬──────────────────────┘
                    │ HTTPS
       ┌────────────┼──────────────┐
       ▼            ▼              ▼
 OpenAI-compatible Gemini Native  xAI / Custom
```

### 5.2 “App Server”不是新的生成 API

App Server 只负责：

- 避免 API Key 暴露在浏览器；
- 解决 CORS；
- 转换不同请求格式；
- 维护异步任务；
- 用户关闭 PWA 后继续轮询；
- 将结果下载到本地；
- 保存历史；
- 运行自定义请求模板和管理员脚本；
- 提供 WebUI 自己使用的内部接口。

模型计算仍由外部 API 完成。

### 5.3 进程模型

默认只运行一个 Node.js 主进程：

- Fastify HTTP Server；
- JobRunner 单例；
- SSE Event Bus；
- SQLite 连接；
- 媒体处理队列。

自定义 JavaScript Adapter 可以在 `worker_threads` 中执行，但仍属于同一个容器，不是独立服务。

### 5.4 Docker Compose

```yaml
services:
  imagine-media:
    build: .
    container_name: imagine-media
    ports:
      - "3030:3030"
    volumes:
      - ./data:/data
    environment:
      APP_PORT: "3030"
      DATA_DIR: /data
      APP_SECRET: replace-with-a-long-random-secret
      APP_PASSWORD: ""
      MOCK_PROVIDER_ENABLED: "true"
    restart: unless-stopped
```

要求：

- Compose 中只有一个业务 Service；
- 不增加 PostgreSQL、Redis、MinIO 或 Nginx；
- 所有运行数据进入 `/data`；
- 支持等价的单条 `docker run` 命令。

---

## 6. 技术栈

### 6.1 基线

- Node.js 24 LTS；
- pnpm workspace；
- TypeScript；
- React 19；
- Vite 8；
- Fastify 5；
- SQLite；
- Docker 多阶段构建。

依赖采用精确版本或锁定小版本，升级由单独 PR 完成。

### 6.2 前端

- React；
- Vite；
- TypeScript；
- React Router；
- Tailwind CSS；
- Radix UI Primitives；
- TanStack Query：服务端数据；
- Zustand：仅界面瞬时状态；
- React Hook Form + Zod；
- `@tanstack/react-virtual`：画廊虚拟化；
- `vite-plugin-pwa` + Workbox；
- i18next；
- Vitest；
- Playwright；
- Storybook 可选，不作为首发硬依赖。

### 6.3 App Server

- Fastify；
- Zod；
- Drizzle ORM；
- `better-sqlite3`；
- `undici`/原生 `fetch`；
- `p-queue` 或小型自建并发队列；
- Pino；
- Sharp；
- FFmpeg/ffprobe；
- Node `crypto`；
- Server-Sent Events。

### 6.4 为什么不用 Next.js

本项目不需要 SSR、复杂 SEO 或 Server Components。

React SPA + Fastify 更适合：

- 单容器；
- PWA；
- 自定义 API Bridge；
- 长任务；
- 本地持久化；
- 未来 Electron 复用。

### 6.5 为什么不用官方 SDK 作为统一核心

为了兼容自定义 Base URL、中转站和非完全标准响应，核心 Provider 层优先使用明确的 HTTP Schema 和 Adapter。

官方 SDK 可以用于：

- 对照测试；
- 部分原生 Provider；
- 文档示例。

但 UI 和核心任务逻辑不得依赖某一家 SDK 的对象模型。

---

## 7. 仓库结构

```text
.
├── apps/
│   ├── web/
│   │   ├── public/
│   │   └── src/
│   │       ├── app/
│   │       ├── routes/
│   │       ├── features/
│   │       │   ├── imagine/
│   │       │   ├── gallery/
│   │       │   ├── composer/
│   │       │   ├── viewer/
│   │       │   ├── editor/
│   │       │   ├── library/
│   │       │   ├── providers/
│   │       │   └── settings/
│   │       ├── components/
│   │       ├── hooks/
│   │       ├── stores/
│   │       ├── query/
│   │       ├── styles/
│   │       └── test/
│   └── server/
│       ├── migrations/
│       └── src/
│           ├── routes/
│           ├── providers/
│           ├── jobs/
│           ├── database/
│           ├── storage/
│           ├── media/
│           ├── adapters/
│           ├── security/
│           ├── events/
│           └── index.ts
├── packages/
│   ├── shared/
│   ├── provider-contract/
│   ├── image-core/
│   ├── image-editor/
│   ├── upload-core/
│   ├── custom-adapter-schema/
│   └── testkit/
├── docs/
│   ├── design-spec/
│   ├── architecture/
│   ├── providers/
│   └── third-party/
├── examples/
│   └── adapters/
├── deploy/
│   └── docker/
├── Dockerfile
├── docker-compose.yml
├── pnpm-workspace.yaml
├── AGENTS.md
├── PLAN.md
├── THIRD_PARTY_NOTICES.md
└── LICENSE
```

不需要 Turborepo。

---

## 8. 前端页面与交互规格

### 8.1 路由

建议：

```text
/imagine          主生成画廊
/saved            收藏和已保存内容
/folders/:id      文件夹/集合
/jobs             全部任务，可选隐藏在二级入口
/settings         设置
/settings/providers
/settings/storage
/settings/pwa
```

进入根路径时跳转到 `/imagine`。

### 8.2 桌面 App Shell

核心结构：

- 左侧窄导航 Rail；
- 主内容区全高；
- 顶部极轻量控制区；
- 中央沉浸式瀑布流；
- 底部居中的悬浮 Composer；
- Viewer 使用全屏 Overlay；
- 设置页可以使用更传统的表单布局，但视觉 Token 必须一致。

要求：

- 侧栏不得演变成 Open WebUI 式大聊天列表；
- 主画廊不得被永久参数面板压缩；
- 高级参数默认收进 Popover/Sheet；
- 生成入口始终是视觉中心之一。

### 8.3 手机 App Shell

手机端不是桌面缩放版。

必须包含：

- 简洁顶部栏；
- 双列或按参考比例调整的紧凑画廊；
- 底部安全区 Composer；
- 参数 Bottom Sheet；
- 横向参考图条；
- 全屏 Viewer；
- 左右滑动切换内容；
- 长按进入多选；
- `safe-area-inset-top/bottom`；
- `visualViewport` 软键盘适配；
- standalone PWA 下不模拟浏览器标题栏。

### 8.4 Composer

Composer 是最重要的交互组件。

组成：

- 上传/附件按钮；
- Prompt 输入区；
- 图片/视频模式选择；
- 模型或 Profile 选择；
- 比例/尺寸/数量/时长快捷控制；
- 高级参数入口；
- 提交按钮；
- 正在提交反馈；
- 参考图缩略图；
- 上传进度；
- 参数不兼容提示。

交互：

- 空 Prompt 时提交按钮禁用；
- 粘贴图片直接加入参考图；
- 拖入图片出现 Drop Overlay；
- 切换 Provider 后根据 Capability 动态收缩参数；
- 发送后立即在画廊插入生成中卡片；
- Prompt 保留在本地草稿，成功提交后按设置决定是否清空；
- 移动端键盘弹出时 Composer 不得被遮挡；
- 支持 `Ctrl/Cmd + Enter` 提交；
- 支持 Esc 关闭弹层。

### 8.5 画廊

功能：

- 图片和视频混排；
- 按创建时间倒序；
- 生成中占位；
- 乐观插入；
- 虚拟化；
- 无限加载；
- 维持稳定列宽；
- 图片加载前使用已知比例预留空间；
- 视频显示海报和时长；
- 失败卡片保留 Prompt 和重试入口；
- 支持收藏、保存到文件夹和删除；
- 支持过滤图片、视频、进行中、失败、收藏；
- 避免因缩略图后加载造成大面积跳动。

### 8.6 卡片状态

必须实现：

```text
queued
submitting
remote_pending
remote_running
downloading
processing
completed
failed
cancelled
rejected
```

每种状态有明确视觉，不只是一行小字。

生成中卡片：

- 显示统一骨架或模糊预览；
- 可显示 Provider 返回的进度；
- 无真实进度时显示阶段而不是假百分比；
- 支持取消；
- 鼠标悬停或点击可查看任务详情。

### 8.7 图片 Viewer

包含：

- 原图适配窗口；
- 缩放；
- 拖动；
- 上一项/下一项；
- 下载；
- 收藏；
- 删除；
- 复制 Prompt；
- 作为参考图继续；
- 编辑图片；
- 图片转视频；
- 查看实际请求参数；
- 显示 Provider/模型/尺寸/时间；
- 移动端手势和双击缩放。

### 8.8 视频 Viewer

包含：

- 原生或定制播放器；
- HTTP Range；
- 播放/暂停；
- 进度拖动；
- 静音/音量；
- 全屏；
- 下载；
- Poster；
- 生成信息；
- 重新生成；
- 使用首帧/中间帧/末帧继续创作，可作为后续功能；
- 视频编辑/延长入口只在 Provider 支持时显示。

### 8.9 图片编辑

首发支持：

- 自然语言编辑；
- 单图或多参考图；
- Mask；
- 画笔大小；
- 橡皮擦；
- 撤销/重做；
- 清空 Mask；
- 原图/结果切换；
- 编辑结果自动进入同一画廊；
- 与父资产建立关系。

图片编辑的内部算法可以移植自 `gpt_image_playground`，但编辑页面和工具栏必须重新适配本项目 UI。

### 8.10 Saved、文件夹和集合

为接近 Grok Imagine 的内容管理体验，建议首发至少实现：

- 收藏；
- Saved 页面；
- 新建文件夹；
- 移入文件夹；
- 从文件夹移除；
- All 过滤；
- 多选；
- 批量下载；
- 批量删除。

若工期受限，文件夹可以安排在 v0.2，但 UI 壳和数据库扩展位应保留。

### 8.11 Provider 设置页

设置页不要求复刻 Grok，因为 Grok 没有本项目的多 API 配置需求。

仍应保持同一视觉语言：

- Provider 卡片；
- Base URL；
- API Key；
- 自定义 Header；
- 请求格式；
- 模型列表；
- Capability；
- 测试连接；
- 设为默认；
- 启用/禁用；
- 无 Secret 导出；
- 导入配置；
- 高级调试。

### 8.12 Design Token

从参考截图测量后建立：

```text
apps/web/src/styles/tokens.css
```

分类：

- 背景层级；
- 边框；
- 文本；
- 弱化文本；
- Hover；
- Active；
- Focus；
- 危险状态；
- 圆角；
- 阴影；
- 间距；
- 字号和行高；
- 动效时长；
- Easing；
- Z-index。

不得在组件里散落大量随意 hex 值。

### 8.13 动效

需要复现的主要节奏：

- Composer 展开/收起；
- Popover/Sheet 出现；
- 卡片 Hover；
- Viewer 打开；
- 生成中阶段；
- 新卡片插入；
- 列表筛选；
- Toast；
- PWA 更新提示。

同时支持：

```css
@media (prefers-reduced-motion: reduce)
```

---

## 9. 前端状态架构

### 9.1 状态边界

TanStack Query 管理：

- Provider；
- 模型；
- Job；
- Asset；
- Gallery；
- Collection；
- Settings。

Zustand 仅管理：

- 当前 Composer 草稿引用；
- 弹层开关；
- Viewer 当前索引；
- 多选状态；
- 临时画笔状态；
- 本地 UI 偏好。

不得把服务端历史、所有任务和所有 Provider 塞进一个巨型 Store。

### 9.2 Feature 分层

每个 Feature 至少分为：

```text
api/
components/
hooks/
model/
schemas/
test/
```

Provider 请求逻辑不能出现在 React 组件中。

### 9.3 Mock First

PR 1 的 UI 全部使用固定 Mock 数据：

- 固定 30 张图片；
- 固定 8 个视频 Poster；
- 固定各种比例；
- 固定进行中任务；
- 固定失败任务；
- 固定收藏和文件夹；
- 固定 Provider Capability。

这样视觉实现不会被真实 API 波动拖累。

---

## 10. PWA

### 10.1 首发 P0

必须支持：

- Web App Manifest；
- `display: standalone`；
- 192/512 图标；
- Maskable Icon；
- 桌面和手机截图元数据；
- Service Worker；
- App Shell 离线打开；
- Chromium 安装按钮；
- iOS 添加到主屏幕说明；
- 新版本可用提示；
- Prompt 草稿；
- 安全区；
- 软键盘适配；
- PWA 重开后恢复任务和画廊。

### 10.2 Service Worker 边界

Service Worker 负责：

- 静态资源缓存；
- App Shell；
- 最近缩略图；
- 最近视频 Poster；
- 离线占位页；
- 更新检测。

Service Worker 不负责：

- 持续轮询生成任务；
- 存储 API Key；
- 缓存 Authorization；
- 离线伪提交生成；
- 缓存完整大视频；
- 执行 Provider 请求。

任务存活依赖容器中的 JobRunner，而不是浏览器后台能力。

### 10.3 离线行为

离线时：

- 可启动应用；
- 可查看最近缓存的缩略图和 Poster；
- 可编辑 Prompt 草稿；
- 明确显示离线状态；
- 禁止提交生成任务；
- 网络恢复后自动刷新任务状态。

---

## 11. Provider 与统一请求模型

### 11.1 统一操作

```ts
type MediaOperation =
  | 'image.generate'
  | 'image.edit'
  | 'video.generate'
  | 'video.image_to_video'
  | 'video.reference_to_video'
  | 'video.edit'
  | 'video.extend';
```

### 11.2 统一请求

```ts
interface GenerationRequest {
  operation: MediaOperation;
  providerId: string;
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  inputs: AssetInput[];
  aspectRatio?: string;
  width?: number;
  height?: number;
  resolution?: string;
  count?: number;
  durationSeconds?: number;
  fps?: number;
  quality?: string;
  format?: string;
  seed?: number;
  audio?: boolean;
  extra?: Record<string, unknown>;
}
```

### 11.3 Capability

```ts
interface ModelCapabilities {
  operations: MediaOperation[];
  aspectRatios?: string[];
  resolutions?: string[];
  durations?: number[] | { min: number; max: number };
  maxReferenceImages?: number;
  supportsMask?: boolean;
  supportsNegativePrompt?: boolean;
  supportsSeed?: boolean;
  supportsAudio?: boolean;
  supportsProgress?: boolean;
  supportsCancel?: boolean;
  supportsBatchCount?: boolean;
  maxBatchCount?: number;
  customFields?: JsonSchema;
}
```

UI 只渲染当前模型支持的参数。

### 11.4 Provider Adapter

```ts
interface ProviderAdapter {
  readonly type: string;

  getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  validate(request: GenerationRequest, context: ProviderContext): Promise<void>;
  submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult>;
  poll?(remoteJobId: string, context: ProviderContext): Promise<PollResult>;
  cancel?(remoteJobId: string, context: ProviderContext): Promise<void>;
  normalizeError(error: unknown): ProviderError;
}
```

### 11.5 OpenAI / OpenAI-compatible

首发支持版本化 Profile：

```text
openai-images-v1
openai-responses-image-v1
openai-videos-v1-compatible
```

支持：

- 自定义 Base URL；
- API Key；
- 自定义 Header；
- 图片生成；
- 图片编辑；
- JSON 和 multipart；
- URL、Base64、兼容中转返回；
- Responses API 图片工具；
- 同步和流式结果；
- 兼容型异步视频提交和轮询。

注意：官方 OpenAI Videos API 已进入弃用阶段，因此 `openai-videos-v1-compatible` 主要服务于仍采用该请求格式的自建或第三方 API，不得成为项目唯一视频协议。

### 11.6 Gemini Native

使用 Google 原生格式，不强行先转成 OpenAI 格式。

版本化 Profile：

```text
gemini-interactions-image-v1
gemini-generate-content-image-v1
gemini-veo-operation-v1
gemini-omni-interactions-video-v1
```

支持：

- 图片生成；
- 图片编辑；
- 多轮图片编辑；
- 文生视频；
- 图生视频；
- 长运行 Operation；
- 返回 Base64 或文件资源；
- Provider 版本和模型能力差异。

### 11.7 xAI / Grok Imagine

版本化 Profile：

```text
xai-imagine-image-v1
xai-imagine-video-v1
```

支持：

- 图片生成；
- 图片编辑；
- 多参考图；
- 文生视频；
- 图生视频；
- 参考图生视频；
- 异步 `request_id`；
- 轮询；
- Provider 支持时的视频编辑和延长。

不得因为 UI 参考 Grok Imagine，就把所有 Provider 都写成 xAI 参数。

### 11.8 Model Catalog

模型 ID 和能力不能硬编码在 UI。

来源优先级：

1. Provider 动态模型列表；
2. Provider Profile 内置默认；
3. 用户手工添加；
4. 自定义 Adapter Schema。

用户可以覆盖展示名称和 Capability，但需要显示“手动覆盖”标记。

---

## 12. App Server 内部接口

这些接口只供同一应用前端使用。

```text
GET    /internal/health
GET    /internal/app-info

GET    /internal/settings
PATCH  /internal/settings

GET    /internal/providers
POST   /internal/providers
GET    /internal/providers/:id
PATCH  /internal/providers/:id
DELETE /internal/providers/:id
POST   /internal/providers/:id/test
POST   /internal/providers/:id/models/refresh

GET    /internal/models

POST   /internal/jobs
GET    /internal/jobs
GET    /internal/jobs/:id
POST   /internal/jobs/:id/retry
POST   /internal/jobs/:id/cancel
DELETE /internal/jobs/:id

POST   /internal/assets/upload
GET    /internal/assets
GET    /internal/assets/:id
GET    /internal/assets/:id/content
GET    /internal/assets/:id/thumbnail
GET    /internal/assets/:id/poster
DELETE /internal/assets/:id

GET    /internal/collections
POST   /internal/collections
PATCH  /internal/collections/:id
DELETE /internal/collections/:id
POST   /internal/collections/:id/assets
DELETE /internal/collections/:id/assets/:assetId

GET    /internal/events
```

SSE 使用一条连接复用所有任务事件。

---

## 13. JobRunner

### 13.1 同一进程

```ts
class JobRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(jobId: string): Promise<void>;
  resumePendingJobs(): Promise<void>;
  cancel(jobId: string): Promise<void>;
}
```

### 13.2 并发

默认：

- 图片提交并发 2；
- 视频提交并发 2；
- 下载并发 3；
- 媒体处理并发 2；
- 视频轮询不长期占用提交并发槽；
- 每个 Provider 可单独覆盖；
- 429 时退避并抖动。

### 13.3 状态机

```text
queued
  ↓
submitting
  ↓
remote_pending
  ↓
remote_running
  ↓
downloading
  ↓
processing
  ↓
completed
```

异常：

```text
failed | cancelled | rejected | expired
```

### 13.4 崩溃恢复

容器启动时：

- `queued`：重新入队；
- `submitting` 且无远程 ID：根据幂等能力决定重试或标为需人工确认；
- 有远程 ID：继续轮询；
- `downloading`：重新获取结果并下载；
- `processing`：重新生成缩略图/Poster；
- 已完成但文件缺失：进入一致性修复队列。

### 13.5 幂等

每个本地任务生成 `idempotency_key`。

Provider 支持时传递该 Key；不支持时，重启后不得盲目重复提交处于不确定状态的任务。

---

## 14. SQLite

### 14.1 设置

启动时配置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

### 14.2 表

#### `settings`

- key；
- value_json；
- updated_at。

#### `providers`

- id；
- name；
- type；
- base_url；
- encrypted_api_key；
- headers_encrypted_json；
- config_json；
- enabled；
- is_default；
- created_at；
- updated_at。

#### `models`

- id；
- provider_id；
- model_id；
- display_name；
- capabilities_json；
- capability_source；
- enabled；
- created_at；
- updated_at。

#### `jobs`

- id；
- operation；
- provider_id；
- model_id；
- prompt；
- request_json；
- provider_request_redacted_json；
- status；
- stage；
- progress；
- remote_job_id；
- idempotency_key；
- error_code；
- error_message；
- retry_count；
- poll_after_at；
- created_at；
- updated_at；
- completed_at。

#### `assets`

- id；
- job_id；
- parent_asset_id；
- type；
- role；
- file_path；
- thumbnail_path；
- poster_path；
- original_filename；
- mime_type；
- width；
- height；
- duration_ms；
- file_size；
- sha256；
- metadata_json；
- favorite；
- created_at；
- deleted_at。

#### `job_inputs`

- job_id；
- asset_id；
- role；
- sort_order。

#### `collections`

- id；
- name；
- created_at；
- updated_at。

#### `collection_assets`

- collection_id；
- asset_id；
- created_at。

#### `schema_migrations`

- version；
- applied_at。

不创建 users、organizations、billing、quotas 等平台表。

---

## 15. 媒体存储

```text
/data/
├── app.db
├── media/
│   ├── originals/
│   ├── thumbnails/
│   ├── posters/
│   ├── uploads/
│   ├── masks/
│   └── temp/
├── adapters/
├── backups/
└── logs/
```

要求：

- 外部结果尽快下载，不依赖临时 URL；
- 数据库保存相对路径；
- 文件名使用 UUID 或哈希；
- 保留原文件名元数据；
- Sharp 生成图片缩略图；
- ffprobe 获取视频信息；
- FFmpeg 生成 Poster；
- 视频支持 Range；
- 校验真实 MIME；
- 限制上传和远程下载大小；
- 防路径穿越；
- 临时目录定期清理；
- 删除默认进入软删除或系统回收期；
- 提供媒体一致性检查。

---

## 16. 自定义 Provider

### 16.1 声明式 HTTP Adapter

首发必须支持。

可配置：

- 名称；
- Base URL；
- Method；
- Path；
- Header；
- Query；
- JSON/Form/Multipart Body；
- 文件字段；
- 认证位置；
- Job ID 提取；
- Poll URL；
- 状态提取；
- 进度提取；
- 结果 URL/Base64 提取；
- 错误提取；
- 成功/失败状态映射；
- 模型参数 JSON Schema；
- Capability。

示例：

```yaml
id: custom-video
name: Custom Video API
operations:
  - video.generate
  - video.image_to_video
submit:
  method: POST
  path: /v1/videos/generations
  headers:
    Authorization: "Bearer {{ secret.apiKey }}"
  body:
    model: "{{ request.modelId }}"
    prompt: "{{ request.prompt }}"
    aspect_ratio: "{{ request.aspectRatio }}"
    duration: "{{ request.durationSeconds }}"
  remoteJobIdPath: request_id
poll:
  method: GET
  path: /v1/videos/{{ remoteJobId }}
  statusPath: status
  progressPath: progress
  resultUrlPath: video.url
  successValues: [done, completed]
  failedValues: [failed, expired]
```

管理 UI：

- JSON/YAML 导入；
- 导出时默认不含 Secret；
- 连接测试；
- Dry Run；
- 脱敏后的实际请求预览；
- 模拟响应；
- Path 提取测试；
- Capability 预览。

### 16.2 JavaScript Adapter

用于复杂签名、多阶段上传和特殊协议。

```text
/data/adapters/<adapter-id>/manifest.json
/data/adapters/<adapter-id>/adapter.mjs
```

接口：

```js
export function capabilities() {}
export async function submit({ request, provider, http, files }) {}
export async function poll({ remoteJobId, provider, http }) {}
export async function cancel({ remoteJobId, provider, http }) {}
export function normalizeError(error) {}
```

约束：

- 只允许管理员安装；
- 标记为受信任服务端代码；
- 不宣传为安全运行不可信脚本的沙箱；
- 不允许动态安装 npm 包；
- 使用 `worker_threads` 执行；
- 有超时和输出大小限制；
- 只传入必要 Secret；
- 日志脱敏；
- HTTP 仍经过统一安全 Transport；
- 可限制目标 Host。

---

## 17. 安全

首发必须处理：

- API Key 使用 `APP_SECRET` 派生密钥加密；
- 浏览器不能读回明文 Key；
- Cookie 使用 HttpOnly、SameSite；
- 可选 `APP_PASSWORD`；
- 公网部署时启动页提醒设置密码；
- 日志脱敏；
- 请求预览脱敏；
- SSRF 防护；
- 默认阻止访问云 Metadata 地址；
- 默认阻止自定义 Provider 访问 Docker Socket；
- 远程结果下载验证重定向目标；
- 上传大小和类型限制；
- CSRF 或同源写请求保护；
- CSP；
- 不将 Secret 放进 PWA Cache；
- 配置导出默认剔除 Secret；
- 自定义脚本明确标识风险。

对内网 API 的访问需要设置开关和明确警告，不能为了 SSRF 防护彻底破坏用户自建内网服务场景。

---

## 18. 测试策略

### 18.1 单元测试

覆盖：

- Provider payload 构造；
- 返回解析；
- 状态映射；
- Capability；
- Secret 加密；
- 文件路径；
- Mask 算法；
- 图片预处理；
- Job 状态机；
- 崩溃恢复；
- 自定义 Adapter 模板。

### 18.2 Contract Test

每个 Provider Adapter 使用固定 Fixture：

```text
fixtures/providers/<provider>/<profile>/
├── submit-request.json
├── submit-response.json
├── poll-running.json
├── poll-completed.json
├── poll-failed.json
└── expected-normalized.json
```

### 18.3 E2E

Playwright 覆盖：

- 首次进入；
- 图片生成 Mock；
- 视频生成 Mock；
- 上传参考图；
- Mask 编辑；
- 失败重试；
- 取消；
- 刷新恢复；
- 容器重启恢复；
- 收藏；
- 文件夹；
- Provider 配置；
- PWA 更新；
- 手机 Bottom Sheet；
- 软键盘布局模拟。

### 18.4 视觉回归

每个 UI PR 提交：

```text
artifacts/visual/<pr-number>/
├── desktop-1440x900.png
├── desktop-1920x1080.png
├── mobile-390x844.png
├── mobile-430x932.png
└── visual-diff-report.md
```

PR 描述必须包含：

- 参考状态；
- 实现截图；
- 已知差异；
- 差异是否有意；
- 下一步。

### 18.5 Docker Smoke Test

CI 至少执行：

1. 构建镜像；
2. 启动唯一容器；
3. 检查 Health；
4. 提交 Mock Job；
5. 等待完成；
6. 检查 SQLite；
7. 检查媒体文件；
8. 重启容器；
9. 检查历史仍在；
10. 确认 Compose 中没有其他服务。

---

## 19. 开发阶段与 PR 顺序

顺序是本计划最重要的修订之一：**先 UI，后移植功能。**

### PR 0：干净工程、单容器骨架和 UI 参考制度

目标：

- 创建全新仓库；
- 建立 pnpm workspace；
- `apps/web` 和 `apps/server`；
- React/Vite 最小页面；
- Fastify 提供静态页面；
- SQLite/Drizzle 初始化；
- 单 Dockerfile；
- 单 Service Compose；
- `/data`；
- JobRunner 骨架；
- Provider Contract；
- Mock Provider；
- 最小 PWA；
- 建立 `docs/design-spec`；
- 建立 `.design-reference` 规则；
- 建立第三方复用审计；
- 只审查 `gpt_image_playground`，不复制旧 UI。

验收：

- 一个容器启动；
- PWA 可安装；
- Mock Job 写入 SQLite；
- 重启后记录仍在；
- `docs/design-spec/screen-matrix.md` 完成；
- `docs/third-party/reuse-audit.md` 有初始审计；
- 页面只允许是最小占位，不提前继承任何旧 UI。

### PR 1：Grok Imagine 高保真 UI Shell

这是 UI Gate，禁止接真实 API。

目标：

- 桌面 App Shell；
- 手机 App Shell；
- 窄侧栏；
- 主画廊；
- Composer；
- 模式和参数弹层；
- 参考图条；
- 图片/视频统一卡片；
- 所有任务状态；
- 图片 Viewer；
- 视频 Viewer；
- Saved；
- 文件夹 UI；
- 设置页壳；
- 视觉回归；
- 动效；
- 安全区和软键盘。

数据全部来自 Mock Fixture。

硬性验收：

- 达到 L3；
- 核心主界面接近 L4；
- 不存在 `gpt_image_playground` App Shell；
- 不使用旧 Composer 和 Gallery 组件；
- 桌面和手机截图通过评审；
- UI Gate 未通过前，不进入大规模功能迁移。

### PR 2：App Server、媒体和持久化完成

目标：

- 完整内部接口；
- Provider 配置；
- Secret 加密；
- Asset 上传；
- 媒体保存；
- JobRunner；
- SSE；
- 缩略图；
- Poster；
- Range；
- 启动恢复；
- Gallery Query；
- Collection 持久化。

仍以 Mock Provider 为主要验证。

### PR 3：选择性移植图片输入和编辑能力

目标：

- 审查并移植 `gpt_image_playground` 的非视觉模块；
- 拖放；
- 剪贴板；
- 多参考图；
- 图片预处理；
- Mask 内核；
- Base64/URL/Blob 处理；
- 单元测试移植；
- 接入 PR 1 的新 UI。

禁止：

- 复制旧页面；
- 复制旧 Design Token；
- 复制旧巨型 Store；
- 为迁就旧代码改变已验收 UI。

### PR 4：真实图片 Provider

目标：

- OpenAI Images；
- OpenAI Responses 图片工具；
- OpenAI-compatible；
- Gemini Native 图片；
- xAI Imagine 图片；
- 自定义 Base URL；
- Capability；
- 流式/同步结果；
- 实际错误映射；
- 下载到本地；
- 图片编辑和多参考图。

### PR 5：视频任务

目标：

- 文生视频；
- 图生视频；
- 参考图生视频；
- xAI 异步轮询；
- Gemini Veo/Omni Profile；
- OpenAI-compatible Videos Profile；
- 视频 Poster；
- Range 播放；
- 重启恢复；
- 取消；
- 重试；
- 过期结果处理。

### PR 6：自定义 Provider

目标：

- 声明式 HTTP Adapter；
- JSON/YAML；
- Dry Run；
- 脱敏预览；
- 状态和结果提取；
- Capability Schema；
- JavaScript Adapter；
- 示例；
- 安全限制。

### PR 7：PWA 和手机端精修

PWA 从 PR 0 已存在，本 PR 是完整化而不是临时补装。

目标：

- 安装引导；
- iOS 指引；
- 缓存策略；
- 离线状态；
- 更新提示；
- Prompt 草稿；
- standalone 全面验证；
- Android/Windows/macOS 测试；
- 手机手势；
- 性能；
- 辅助功能。

### PR 8：安全、备份和 v0.1.0

目标：

- SSRF；
- 数据备份；
- SQLite Integrity Check；
- 媒体一致性；
- 升级迁移；
- 完整 E2E；
- 视觉基线；
- GHCR 镜像；
- Release 文档；
- v0.1.0。

---

## 20. 首发验收标准

### 20.1 UI

- [x] Grok Imagine 是唯一 UI/UX 基准。
- [ ] 主界面达到 L3，高频核心状态接近 L4（authenticated reference 仍缺失，见 [Hold.md](./Hold.md)）。
- [x] 桌面端不是旧项目换肤。
- [x] 手机端是独立响应式设计，不是桌面缩放。
- [x] Composer、画廊、Viewer、菜单和任务状态符合交互图。
- [x] 图片和视频统一进入画廊。
- [x] 所有状态有明确视觉反馈。
- [x] UI PR 有固定视口截图和差异报告。
- [x] 不复制 Grok Logo、商标和原始资产。

### 20.2 部署

- [x] `docker compose up -d` 只启动一个业务容器。
- [x] 不需要 PostgreSQL、Redis、MinIO 或 Nginx。
- [x] 所有数据在 `/data`。
- [x] 删除并重建容器后历史仍存在。
- [x] 容器重启后继续处理可恢复任务。

### 20.3 Provider

- [x] 可添加 OpenAI-compatible Provider。
- [x] 可添加 Gemini Native Provider。
- [x] 可添加 xAI Provider。
- [x] 可手工增加模型。
- [x] 参数由 Capability 驱动。
- [x] 可测试连接。
- [x] API Key 不出现在浏览器和日志。

### 20.4 图片

- [x] 文生图。
- [x] 图片编辑。
- [x] 多参考图。
- [x] Mask。
- [x] 多图生成。
- [x] 生成结果本地保存。
- [x] 可从结果继续编辑或作为参考。
- [x] 可从图片发起图生视频。

### 20.5 视频

- [x] 文生视频。
- [x] 图生视频。
- [x] 异步轮询。
- [x] 进行中状态。
- [x] 容器重启恢复。
- [x] 下载到本地。
- [x] Poster。
- [x] Range 播放。
- [x] Provider 支持时可取消。

### 20.6 自定义请求

- [x] 声明式 Adapter。
- [x] 同步返回。
- [x] 异步返回。
- [x] JSON、Form、Multipart。
- [x] 自定义 Header。
- [x] Path 提取。
- [x] Dry Run。
- [x] 导入导出。
- [x] 管理员 JavaScript Adapter。

### 20.7 PWA

- [ ] Windows Chromium 可安装（真实平台证据待补，见 [Hold.md](./Hold.md)）。
- [ ] macOS Chromium 可安装（真实平台证据待补，见 [Hold.md](./Hold.md)）。
- [ ] Android 可安装（真实设备证据待补，见 [Hold.md](./Hold.md)）。
- [ ] iOS 可添加到主屏幕（真实设备证据待补，见 [Hold.md](./Hold.md)）。
- [x] standalone 布局正确。
- [x] 离线可打开 App Shell。
- [x] 不缓存 Secret 和生成 POST。
- [x] PWA 关闭后容器继续任务。
- [x] 重开后恢复任务。

### 20.8 资源

- [x] 空闲时只有一个 Node 主进程和 SQLite。
- [x] 无常驻外部数据库和消息队列。
- [x] 瀑布流大量历史下仍保持可用。
- [x] 视频不会被 Service Worker 全量缓存。

---

## 21. Codex 工作规则

1. 本文档替代所有旧计划。
2. Grok Imagine 是唯一 UI/UX Source of Truth。
3. `gpt_image_playground` 仅是非视觉功能代码捐赠者。
4. 禁止以旧项目 App Shell 为起点。
5. 禁止给旧页面换黑色主题后称为复刻。
6. 禁止直接复制旧 Composer、Gallery、Viewer 和页面级 Store。
7. UI PR 1 使用 Mock 数据先完成并通过 UI Gate。
8. UI Gate 通过后再大规模接入功能。
9. 一个 Docker 容器。
10. SQLite 是首发唯一数据库。
11. JobRunner 在同一容器内运行。
12. 不引入 PostgreSQL、Redis、独立 Worker 或 Nginx。
13. 所有运行数据进入 `/data`。
14. 生成能力来自用户已有外部 API。
15. 不将 API Key 放入前端、Local Storage 或 Service Worker Cache。
16. Provider 参数由 Capability 决定，不写死在页面。
17. 每个 PR 必须保持 Docker 可启动。
18. 每个 UI PR 同时验证桌面和手机。
19. 每个 UI PR 提交截图和差异报告。
20. 每次移植第三方代码更新 `reuse-audit.md`。
21. Git commit 作者使用：

```text
YuSaZh <aimescc@icloud.com>
```

22. 每个 PR 都要运行并报告：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
docker compose build
docker compose up -d
```

---

## 22. 首次交给 Codex 的指令：PR 0

```text
请完整阅读 PLAN.md，只执行“PR 0：干净工程、单容器骨架和 UI 参考制度”。

重要边界：

1. 本项目 UI 的唯一基准是 Grok Imagine。
2. 本轮不要以 gpt_image_playground 的页面、App.tsx、Composer、Gallery、Viewer、CSS 或全局 Store 为基础。
3. gpt_image_playground 本轮仅做代码审查，输出可移植的非视觉功能清单，不要把旧 UI 复制进项目。
4. 本项目是调用用户已有外部 API 的轻量 WebUI，不是模型服务和多租户平台。
5. 最终只能有一个 Docker 业务容器，SQLite 和 JobRunner 均在该容器内。

本轮任务：

1. 创建新的 pnpm workspace：apps/web、apps/server、packages/shared、packages/provider-contract、packages/testkit。
2. apps/web 使用 React + Vite + TypeScript，暂时只做中性最小占位页，不设计最终 UI。
3. apps/server 使用 Fastify + SQLite + Drizzle。
4. 编译后的 apps/web 由同一 Fastify 进程提供。
5. 创建单 Dockerfile 和只有一个 Service 的 docker-compose.yml。
6. 所有运行数据保存到 /data，SQLite 位于 /data/app.db。
7. 在同一个 Server 进程内建立 JobRunner 骨架，不创建独立 Worker 容器。
8. 建立 ProviderAdapter、GenerationRequest、ModelCapabilities 和 Mock Provider。
9. 建立最小 PWA：Manifest、Service Worker、standalone、离线 App Shell。
10. 建立 docs/design-spec 目录及模板：screen-matrix、interaction-map、responsive-map、geometry、tokens、motion、visual-diff-policy。
11. 创建 .design-reference/.gitignore 规则并说明如何放置 Grok Imagine 私有参考截图。
12. 添加 donor-gpt-image、reference-ima2、reference-sora 的文档说明；不要把这些仓库代码整体复制进来。
13. 审查 gpt_image_playground，创建 docs/third-party/reuse-audit.md，列出可选择性移植的非视觉模块、风险和测试。
14. 建立 lint、typecheck、unit test、build、Docker smoke test。
15. 设置 Git 提交作者为 YuSaZh <aimescc@icloud.com>。
16. 暂时不要接入任何真实 Provider，也不要开始 PR 1 以后的功能。

验收：

- docker compose up -d 只启动一个业务容器；
- 浏览器可打开；
- PWA 可安装；
- /data/app.db 自动创建；
- Mock Job 可写入 SQLite；
- 重启容器后记录仍存在；
- JobRunner 骨架可恢复 queued Mock Job；
- docs/design-spec 模板齐全；
- reuse-audit.md 已完成初始审查；
- 仓库内没有复用 gpt_image_playground 的页面和视觉组件；
- 报告全部命令结果、文件结构和已知问题。
```

---

## 23. 第二次交给 Codex 的指令：PR 1

PR 0 通过后使用：

```text
请阅读 PLAN.md 和 docs/design-spec，并只执行“PR 1：Grok Imagine 高保真 UI Shell”。

本轮严禁接真实 API。所有内容使用固定 Mock Fixture，以便视觉回归。

目标：

1. 以 .design-reference 中冻结的 Grok Imagine 参考包为唯一 UI/UX 基准。
2. 完成桌面窄侧栏、顶部轻量控制、沉浸式瀑布流和底部悬浮 Composer。
3. 完成手机顶部栏、双列画廊、底部安全区 Composer、参数 Bottom Sheet 和软键盘适配。
4. 实现图片/视频模式、模型/比例/数量/时长控件，但数据由 Mock Capability 提供。
5. 实现参考图条、拖放视觉、上传进度和参数不兼容状态。
6. 实现 queued、submitting、remote_pending、remote_running、downloading、processing、completed、failed、cancelled、rejected 卡片。
7. 实现图片 Viewer、视频 Viewer、Saved、文件夹和设置页 UI 壳。
8. 建立 Design Token，不在组件中散落颜色和尺寸。
9. 建立固定 Mock 媒体和 Playwright 视觉回归。
10. 提交 1920x1080、1440x900、430x932、390x844 四组截图和差异报告。
11. 不复用 gpt_image_playground 的 App Shell、Composer、Gallery、Viewer、CSS 和页面级 Store。
12. 不因旧功能代码方便而改变 Grok Imagine 的布局和交互。
13. 设置 Git 提交作者为 YuSaZh <aimescc@icloud.com>。

验收：

- UI 达到 PLAN.md 定义的 L3；
- 主画廊和 Composer 尽量达到 L4；
- 桌面和手机关键流程完整；
- 视觉回归可重复；
- PWA standalone 页面正确；
- Docker 单容器仍可启动；
- 未接入真实 Provider；
- 给出参考对比、已知差异和下一步建议。
```

---

## 24. 最终技术决策摘要

- **UI 基准：Grok Imagine，且是唯一基准。**
- **前端实现：新建高保真 App Shell，不继承 GPT Image Playground UI。**
- **开源复用：选择性移植 `gpt_image_playground` 的图片逻辑和测试。**
- **开发顺序：先 Mock 高保真 UI，再接持久化和真实 Provider。**
- **部署：一个 Docker 容器。**
- **数据库：SQLite。**
- **任务：同一 Node.js 进程内 JobRunner。**
- **媒体：本地 `/data/media`。**
- **前端：React + Vite + PWA。**
- **App Server：Fastify，只做密钥、协议转换、任务、媒体和历史。**
- **Provider：OpenAI-compatible、Gemini Native、xAI Native、自定义 HTTP/JS。**
- **视频：异步任务写入 SQLite，容器负责轮询和恢复。**
- **PWA：首发 P0，不依赖浏览器维持后台任务。**
- **Electron：未来复用同一前端，不在首发范围。**

---

## 25. 参考来源

本计划的实现参考包括：

```text
UI/UX 目标：
https://grok.com/imagine

图片功能代码捐赠者：
https://github.com/CookSleep/gpt_image_playground

多 Provider 与任务架构参考：
https://github.com/lidge-jun/ima2-gen

视频队列和恢复参考：
https://github.com/alasano/sora-2-playground

PWA：
https://github.com/vite-pwa/vite-plugin-pwa
```

API 实现时必须再次以各厂商当时的官方文档为准，不得把本文中的示例模型 ID 当成永久常量。
