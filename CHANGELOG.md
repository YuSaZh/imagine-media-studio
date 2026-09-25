# Changelog

All notable changes to Imagine Media Studio are documented in this file.

## [Unreleased]

## [0.2.2] - 2026-09-26

发布日期：2026-09-26 · 上一稳定版：v0.2.0（v0.2.1 未通过发布验收）

> 修复 v0.2.1 的浏览器验收失败，统一完整本地 CI 与 GitHub 的执行入口，避免把质量检查误报为完整验收。本版包含手动合并系列、明确的系列删除、移动端搜索与长按多选、站点名称与 Logo 设置。

### 重点更新

- **完整 CI 入口：** `pnpm run ci` 包含质量检查、八个独立浏览器尺寸与隔离 Docker 验收；开发时可以使用明确命名的部分检查入口。Agent 与发布规则统一要求发布前完成本地验收。
- **工作区功能：** 图片与视频可以合并系列，删除可选择封面或整个系列；改进任务提示词、侧栏动画、手机搜索和蒙版入口，支持站点名称和 Logo 设置。([ee72aac](https://github.com/YuSaZh/imagine-media-studio/commit/ee72aac))

### 验收与发布可靠性

- 浏览器测试清理上一场景残留的任务，并按实际界面确认删除失败任务，修复整套测试中出现的任务数量及删除断言失败。
- 蒙版测试等待真实上传完成，退出动画测试等待图库布局完成；页面关闭前等待请求拦截结束，避免异步操作与断言、清理互相抢先。
- Playwright、GitHub 矩阵和发布守卫共享八个尺寸的定义；源码容器验收集中到隔离脚本，保留升级、备份恢复和持久化检查。
- Test Image 与正式发布使用同一提交的最新 main CI 及必需任务结果；清理早期阶段命名，并固定 CI Action 的提交版本。

### 升级说明与限制

- v0.2.1 标签保留，使用 v0.2.2 发布修复结果。本版不新增数据库迁移；从 v0.2.0 升级会应用已有的 `0012_manual_series.sql`，既有数据和设置保留。
- Mock Provider、浏览器模拟和容器验收不代表真实付费 Provider 或实体设备验收。最终镜像仍须通过 GitHub 的 digest 验收才会正式发布。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.2.0...v0.2.2](https://github.com/YuSaZh/imagine-media-studio/compare/v0.2.0...v0.2.2)

## [0.2.1] - 2026-09-26

发布日期：2026-09-26 · 上一稳定版：v0.2.0

> 图片、视频和混合选择可以手动合并为持久化系列；系列删除明确区分封面与整组，失败任务和长提示词更易管理。桌面侧栏、手机搜索与长按多选更连贯，并可在偏好中设置网站名称和 Logo。

### 重点更新

- **手动合并系列：** 多选图片、视频或混合内容后，可合并为一个系列，刷新和重启后保留；仍保留已有生成来源关系和账号隔离。([ee72aac](https://github.com/YuSaZh/imagine-media-studio/commit/ee72aac))
- **系列删除和失败任务：** 提供取消、仅删除封面和删除整个系列三个操作；失败系列菜单、单个任务和任务列表均可删除失败记录。([ee72aac](https://github.com/YuSaZh/imagine-media-studio/commit/ee72aac))
- **更紧凑的移动端：** 顶部搜索与标题带动画切换，保留导航按钮；空搜索点击外部收起，有内容时保持展开。长按作品进入多选，移除重复标题行。([ee72aac](https://github.com/YuSaZh/imagine-media-studio/commit/ee72aac))
- **站点外观：** 管理员可修改网站名称、上传或恢复默认 Logo；登录页、侧栏、浏览器标题和图标同步更新。([ee72aac](https://github.com/YuSaZh/imagine-media-studio/commit/ee72aac))

### 工作区与无障碍体验

- 桌面侧栏展开/收起加入过渡动画，多选工具栏跟随输入框高度；动效遵循偏好和系统减少动效设置。
- 任务提示词使用完整正文宽度，末尾显示省略号和“展开全部”；展开后由任务面板滚动，可在文末收起。
- 移动端蒙版按钮直接浮在输入框上方，系列缩略图保持全宽；带未完成或失败任务的系列封面复用作品卡片，保留悬浮操作和信息。
- 优化系列查看器的原图归属、失败任务详情与删除、重试状态，以及编辑器退出动画和回归测试。([ec1f5a1](https://github.com/YuSaZh/imagine-media-studio/commit/ec1f5a1)、[3e2ec74](https://github.com/YuSaZh/imagine-media-studio/commit/3e2ec74))

### 文档

- 精简项目 README，补充日文指南，统一主要部署与使用入口。([131ce13](https://github.com/YuSaZh/imagine-media-studio/commit/131ce13))

### 升级说明与限制

- 新增数据库迁移 `0012_manual_series.sql`，保存手动系列关联；既有账号、项目、媒体和设置继续保留。迁移只能向前应用，回退前应确认数据库兼容性。
- 手动合并会连接所选作品已有的编辑系列；整组删除会解析完整成员，运行中的任务或截断的超大系列需先处理后再删除。
- 网站名称和 Logo 对所有账号及未登录页面公开，只有管理员可修改；上传支持不超过 512 KB 的 PNG、JPEG、WebP，并由服务器校验、转换为 PNG。
- 本地与浏览器夹具验证不代表真实付费 Provider、实体设备键盘或原生 PWA 安装验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.2.0...v0.2.1](https://github.com/YuSaZh/imagine-media-studio/compare/v0.2.0...v0.2.1)

## [0.2.0] - 2026-09-22

发布日期：2026-09-22 · 上一稳定版：v0.1.9

> 偏好设置新增深色主题与英文、日文界面；从作品缩略图进入编辑器时，放大与主界面渐隐同步进行，手机输入框和系列批量选择也更连贯。

### 重点更新

- **主题与语言按账号保存：** 支持浅色、深色、跟随系统，以及简体中文、English、日本語；切换保留草稿和当前浮层，不改变作品颜色或用户内容。([0a16228](https://github.com/YuSaZh/imagine-media-studio/commit/0a16228))
- **进入编辑器更平滑：** 缩略图放大的同时主界面渐隐，原图解码完成后在相同位置替换；慢加载期间持续显示预览，减少加载闪屏。([1557cf8](https://github.com/YuSaZh/imagine-media-studio/commit/1557cf8))
- **模式切换与手机输入更连贯：** 图片/视频及视频生成模式使用滑动指示器；手机主界面仅在输入框聚焦或已有内容时展开完整输入区域。
- **选择模式保留系列：** 是否合并系列继续遵循偏好设置；选中系列卡片时，批量收藏、加入项目、删除作用于整个系列。

### 工作区与无障碍体验

- 深色样式覆盖图库、编辑器、生成菜单和设置；系统主题变化可即时跟随，主题与语言在刷新后恢复，并保持账号隔离。
- 界面文案支持中英日切换，日期使用所选语言格式；提示词、文件名、项目名、模型名及上游错误内容保持原文。
- 优化侧栏、底部面板和浮层关闭动画及焦点恢复；动画遵循减少动效偏好与系统设置。

### 发布流程

- 正式发布复用相同提交的 main CI 结果，标签流程等待已有检查而不重复运行源码验收；实际候选镜像仍按不可变 digest 验证，通过后直接晋升同一镜像。([1557cf8](https://github.com/YuSaZh/imagine-media-studio/commit/1557cf8))

### 升级说明与限制

- 相比 v0.1.9 没有新增数据库迁移，保留已有数据与设置；默认仍为浅色和简体中文，可在偏好中更改。
- 系列批量操作覆盖整个系列，删除前请确认所选范围；关闭系列分组后可按单个作品选择。
- 浏览器、Mock Provider 和隔离容器测试不代表真实付费 Provider 或实体设备 PWA 验收；浏览器正常 PWA 安装仍需 HTTPS，本机 localhost 开发地址除外。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.9...v0.2.0](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.9...v0.2.0)

## [0.1.9] - 2026-09-20

发布日期：2026-09-20 · 上一稳定版：v0.1.8

> 并发生图从生成阶段就能按系列浏览，每完成一张即可查看；参考图是否加入系列可单独选择，手机输入框更简洁，作品缩略图的预加载与缓存更稳定。

### 重点更新

- **生成中即可打开系列：** 同次并发生图从提交时合并为一个入口，无需等待首张结果；点击进入后显示各任务状态，结果完成后即可查看，刷新页面也能恢复。([20776a9](https://github.com/YuSaZh/imagine-media-studio/commit/20776a9))
- **参考图加入系列可选：** “按照系列显示”下新增“上传参考图加入系列”子选项，开启后与生成结果合并，关闭时独立显示；设置按账号保存，并同步应用于列表和查看器。
- **缩略图更早准备并复用缓存：** 视口上下 1000px 内的缩略图低优先级预加载，可见图片保持高优先级；补齐浏览器和 PWA 缓存校验，减少往返滚动时的重复下载。([fb6ee34](https://github.com/YuSaZh/imagine-media-studio/commit/fb6ee34))

### 生成与系列浏览

- 部分结果已完成时，系列卡片保留已生成封面和剩余任务，不再拆成作品卡与多张生成占位卡。
- 新增基于任务的系列读取入口，零成品时也可访问；保持账号隔离、来源关系、项目过滤及失败任务状态。
- 查看器持续更新已完成作品和待完成任务；选定仍在生成的任务后，该任务完成时自动切换到结果。

### 手机体验与缓存可靠性

- 手机创作页和编辑器移除输入框底部重复显示的模型、尺寸与张数摘要；生成设置和参数快捷入口继续可用。
- 缩略图与视频封面支持 ETag、Last-Modified 和 304 校验，账号切换、退出和删除时清理对应缓存；HTTP 缓存与离线预览仍受账号边界约束。

### 升级说明与限制

- 相比 v0.1.8 没有新增数据库迁移，保留已有数据与设置；从更早版本升级仍会按顺序应用已有迁移。
- “上传参考图加入系列”默认关闭。需要将上传参考图放入结果系列时，请在偏好中开启该子选项；编辑源图和首帧来源关系保持原有规则。
- 并发生图系列仍需开启父级系列显示和并发生图子选项；无批次记录的历史任务不会被推断合并。
- 浏览器、Mock Provider 和隔离容器测试不代表真实付费 Provider 或实体设备 PWA 验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.8...v0.1.9](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.8...v0.1.9)

## [0.1.8] - 2026-09-12

发布日期：2026-09-12 · 上一稳定版：v0.1.7

> 作品库先显示占位卡片，优先加载最近且可见的图片；详情改为不挤压画面的浮动卡片，长提示词按可用空间折叠，并支持把同次并发生图整理为系列。

### 重点更新

- **逐张显示作品：** 元数据加载期间显示瀑布流占位，缩略图各自完成后独立显示；尚未进入可视区的卡片不提前请求图片，慢图或失败图片不会阻塞其他作品。([d9341de](https://github.com/YuSaZh/imagine-media-studio/commit/d9341de))
- **双端浮动详情：** 桌面详情加宽并覆盖在画面上方，手机卡片按内容增高且受视口上限约束；长提示词充分利用剩余空间，展开后卡片尺寸保持不变，在内部滚动查看。([392811f](https://github.com/YuSaZh/imagine-media-studio/commit/392811f))
- **并发生图系列：** 偏好新增“并发生图作为系列显示”，开启父级系列显示后，可将主界面同次生成的多张图片合并为系列，保留编辑来源关系及项目、收藏和隐私过滤。
- **首页优先加载：** 移除刷新时闪现的“Checking access”页面，保留登录校验；编辑器模块在首页数据及可见图片完成后利用空闲时间预加载，合并连续事件触发的数据刷新，减少重复请求。

### 详情与移动端交互

- 详情中的“作品信息”和关闭按钮固定在卡片顶部，滚动正文时仍可操作；手机点击卡片外部关闭详情，卡片自身的项目菜单继续可用。
- 提示词折叠行数由卡片最大高度及其他信息占用空间计算，末尾显示省略号，提供展开、收起和完整复制；短提示词不强制折叠，滚动区域隐藏滚动条。
- 创建时间上方新增生成耗时；依照任务起止记录显示，无任务记录的上传作品显示占位符。
- 手机编辑器支持边缘滑动退出，移除不适用的分页按钮，保留媒体缩放、视频原生操作与减少动效偏好。([ef94e15](https://github.com/YuSaZh/imagine-media-studio/commit/ef94e15))

### 状态与生成可靠性

- 修复账号和项目范围内的模型、生成参数及偏好恢复问题；设置保存后的事件按账号同步，避免切换项目或重新加载时覆盖已保存的选择。
- 统一异步登录校验与频率限制，优化系列关系查询；合并事件失效通知并避免反复取消正在进行的数据刷新。
- 修复快速切换系列成员时，旧画廊响应覆盖“最近查看”封面的问题；新选择立即显示，待设置写入完成后再同步服务端结果。
- 移除应用层的生成提交与轮询并发上限，保留单请求超时、重试预算，以及本地下载和媒体处理的并发边界；上游渠道自身的配额和并发限制仍适用。

### 升级说明与限制

- 启动时自动应用新增迁移 `0011_generation_batches.sql`，保留已有账号、项目、媒体和设置。迁移只记录此后创建的生图批次，不推断历史作品属于同一次生成；并发生图系列选项默认关闭。
- 数据库迁移仅支持向前升级。需要回退旧版本时，应使用已验证兼容的数据或升级前归档，具体流程见[发布指南](https://github.com/YuSaZh/imagine-media-studio/blob/v0.1.8/RELEASE.md)。
- 编辑器预加载仍取决于网络和浏览器空闲情况；直接进入编辑器时若模块尚未就绪，仍可能短暂显示加载状态。
- 发布验证使用隔离数据库、Mock Provider 和测试素材，不代表真实付费提供商或实体设备 PWA 验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.7...v0.1.8](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.7...v0.1.8)

## [0.1.7] - 2026-09-10

发布日期：2026-09-10 · 上一稳定版：v0.1.6

> 将连续编辑的图片与视频串成可恢复的系列，支持按系列整理作品库，改善桌面和手机浏览衔接，并用一个设置统一控制 HTTP 连接和媒体下载。

### 重点更新

- **连续编辑与系列浏览：** 原图、衍生图片和视频、进行中及失败任务集中在编辑器系列栏中；重新打开任意成员可恢复系列，生成结果完成后自动选中。([e5b02c1](https://github.com/YuSaZh/imagine-media-studio/commit/e5b02c1))
- **按系列整理作品：** 偏好新增“按照系列显示”，支持最新生成、最近查看和原图三种封面；卡片显示成员数量，切换作品后最近查看封面及时更新。
- **双端导航衔接：** 桌面可在系列边界继续浏览相邻作品，手机横向切换系列成员、纵向切换作品；滑动预览跟随手指，并遵循减少动效设置。
- **统一 HTTP 开关：** 管理员可在“设置 → 偏好”切换“是否允许 HTTP 内容”，同时控制提供商调用和生成结果下载，保存后立即生效并跨重启保留。

### 编辑与作品库

- 编辑提交后在主舞台显示生成状态和耗时；选择缩略图可返回已有作品，失败状态保留错误反馈与提示词复制。作品库失败卡片也可复制完整提示词。
- 系列按主要编辑输入重建，额外参考图与蒙版不会合并无关系列；临时视频帧保留来源关系但不显示为独立作品。
- 系列分组在服务端分页前完成，封面与数量遵循项目、媒体类型、收藏、搜索和隐私过滤；多选模式仍按单件作品操作。
- 修复冷缓存打开作品时短暂显示上次关闭内容的问题；同一范围内切换媒体类型时保留已有作品，减少空白等待。

### 桌面与移动端

- 手机编辑器采用更小的系列缩略图和浮动工具，蒙版入口随提示词聚焦显示；闲置时隐藏不适用的模型提示。
- 优化缩略图选中边框、系列数量标记、媒体切换与拖动回弹；原生视频操作、缩放和减少动效偏好保持可用。

### 升级说明与限制

- 本版本不新增数据库迁移，保留已有账号、项目、媒体和模型设置。系列默认不合并，需要在偏好中开启；单个系列遍历最多 1000 个节点，超过时显示部分内容提示。
- `ALLOW_INSECURE_PROVIDER_HTTP` 与 `ALLOW_HTTP_MEDIA_DOWNLOADS` 的默认值均改为 `true`。首次初始化统一开关时，旧配置中任一值为 `false` 就保留关闭；之后以数据库保存的设置为准，环境变量不再覆盖已保存选择。
- HTTP 不加密传输；私网访问仍需独立授权，云元数据地址继续禁止。只有管理员能修改实例级 HTTP 设置。
- 本地全量质量检查、HTTP 设置双端验证和独立容器持久化检查已通过；使用注入传输与测试素材，不代表真实付费提供商调用验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.6...v0.1.7](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.6...v0.1.7)

## [0.1.6] - 2026-09-09

发布日期：2026-09-09 · 上一稳定版：v0.1.4

> 更方便地整理项目作品，优化桌面与手机输入体验，显示生成进度和耗时，并移除会阻止启动的运行锁机制。

### 重点更新

- **项目整理：** 作品菜单新增“移动到项目”，可从作品库归档或跨项目移动；删除项目时可选择同时删除项目内文件，默认保留作品。
- **输入与导航：** 提示词输入框随内容增高，桌面最多五行、手机最多四行；桌面原有窄边栏可原位展开，Logo 保持原位。
- **生成状态：** 进行中的卡片显示“生成中”和已过秒数，完成作品在模型 ID 后显示 `48s`、`1m10s` 等耗时。
- **启动可靠性：** 移除应用运行锁及其残留锁处理，不再因旧运行锁阻止应用启动。

功能与修复见 [99b314f](https://github.com/YuSaZh/imagine-media-studio/commit/99b314f)。

### 项目与模型管理

- 移动作品会原子替换旧项目归属，刷新项目计数和隐私过滤；删除项目内作品时同步移除其在其他项目中的引用，沿用已有文件清理机制。
- 作品更多菜单适当收窄；项目删除确认新增默认不勾选的文件删除选项。
- 修复“复制模型配置”和“模型调用协议”列表无法用滚轮滚动的问题；当前供应商已添加的模型从添加目录中隐藏，删除后重新出现。

### 桌面与移动端

- 桌面展开边栏保留导航与项目分区，主内容让位，无新增遮罩或模糊层；移动端继续使用原有抽屉导航。
- 手机输入框失焦后折叠至两行，再次聚焦恢复内容所需高度；桌面失焦保持高度。主创作框和编辑工作区共用高度逻辑。

### 升级说明与限制

- 本版本不新增数据库迁移，保留现有账号、作品、项目和模型配置。
- 移除运行锁后，全量文件归档的一致性由操作者保证：创建归档前仍须停止应用写入。普通路径与符号链接安全校验保留；历史锁文件不会阻止启动。
- 项目内文件删除沿用软删除及保守清理流程，不承诺立即释放仍被任务引用的文件。生成耗时依赖任务记录；缺少记录的作品不显示虚构耗时。
- 本地质量检查及桌面、手机浏览器回归已通过；这些测试不代表真实付费供应商调用验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.4...v0.1.6](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.4...v0.1.6)

## [0.1.4] - 2026-09-09

发布日期：2026-09-09 · 上一稳定版：v0.1.3

> 图片和视频可在作品详情页直接编辑与生成，模型能力配置更统一，隐私项目可隐藏作品，移动端操作也更轻量。

### 重点更新

- **原地编辑图片和视频：** 详情页使用可展开的浮动输入框，任务进度和生成结果留在当前页，支持继续编辑结果；视频切换生图后仍可拖动，仅打开蒙版或发送时截取当前帧。
- **统一模型能力库：** 已识别模型在添加目录中高亮置顶并自动载入能力，未知模型可以复制模板；覆盖 Gemini、OpenAI、Grok，以及 MAI-Image、Seedream、Seedance 的已收录兼容模板。
- **隐私项目：** 隐私项目的作品从最近创作和全部作品中隐藏，项目列表不直接展示内部内容。
- **更简洁的双端界面：** 媒体卡片可复制完整提示词，新增返回顶部按钮，修复选择边框被裁切、移动端输入框聚焦跳动和模式按钮点击区域问题。

本次功能与修复见 [1e36686](https://github.com/YuSaZh/imagine-media-studio/commit/1e36686)。

### 编辑与生成

- 图片编辑支持鼠标位置锚定的滚轮缩放、拖动及双击还原；蒙版工具栏移至画布底部，应用后显示覆盖效果，聚焦输入框时显示蒙版入口。
- 支持图片输入的模型可使用蒙版：原生能力发送原图和独立蒙版，其余模型接收带半透明标记的合成图与固定范围说明；模型原生能力标记保持真实。
- 视频编辑、续写和首尾帧按协议及模型声明启用，持久化来源记录与有效能力快照；未知自定义视频模型不再被强行套用 Sora 的尺寸和时长限制。
- 截帧和对应蒙版作为临时输入，不进入资源库；服务端在相关任务结束后清理媒体文件，未提交输入保留最多 24 小时，备份和媒体检查兼容清理后的历史记录。

### 模型管理与使用体验

- 统一目录识别、别名、能力载入和模板复制，修复 `imageResolution` 能力校验报错，保留用户已经编辑的模型配置。
- 按模型能力和操作策略约束画幅、分辨率、参考图与时长，不再要求所有模型选分辨率后必须选择画幅；生成参数默认折叠。
- 移动端卡片使用半透明图标并降低阴影，更多设置的值与标签字号保持一致；返回顶部和蒙版按钮与发送按钮对齐。
- 登录页使用标准用户名、密码和登录文案，不自动填入管理员用户名，保留浏览器自动填充能力。

### 升级说明与限制

- 启动时应用新增的视频来源和项目隐私迁移；既有项目默认公开，账号、素材和模型配置保持保留。升级与回退流程见 [发布指南](https://github.com/YuSaZh/imagine-media-studio/blob/v0.1.4/RELEASE.md)。
- Mock Provider 默认关闭，仅显式启用测试配置时提供，不再自动出现在普通部署中。
- 兼容模板只启用当前协议能表达的能力，不保证所有上游渠道均支持。非原生蒙版是视觉范围提示，不保证精确局部编辑；临时帧清理后需要确认视频位置并重新发送，不自动重新生成。
- 本地通过全量质量检查、八视口延迟截帧验证和编辑器回归；上游协议使用注入传输与 Mock 验证，不代表已完成真实付费渠道验收。

### 贡献者

- [@YuSaZh](https://github.com/YuSaZh)

完整变更：[v0.1.3...v0.1.4](https://github.com/YuSaZh/imagine-media-studio/compare/v0.1.3...v0.1.4)

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
