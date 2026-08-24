# Information Architecture

本文件描述路由、导航层级、主要区域和内容关系。它不是 PR 0 的最终界面方案；所有参考站点的层级与命名必须由私有证据确认。

## 路由清单

| Route ID | 路径 | 目的 | 主对象 | 入口 | 返回目标 | 来源 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ROUTE-001` | `/` | 重定向 | - | 直接访问 | `/imagine` | Product requirement | Frozen |
| `ROUTE-002` | `/imagine` | 主生成画廊 | Job, Asset | 主导航 | `TBD` | Reference-aligned | Draft |
| `ROUTE-003` | `/saved` | 收藏内容 | Asset | 主/二级导航 `TBD` | `/imagine` `TBD` | Reference-aligned | Draft |
| `ROUTE-004` | `/folders/:id` | 文件夹/集合 | Collection, Asset | 集合入口 | `TBD` | Reference-aligned | Draft |
| `ROUTE-005` | `/jobs` | 全部任务 | Job | 二级入口 `TBD` | `TBD` | Project extension | Draft |
| `ROUTE-006` | `/settings` | 设置入口 | Settings | 设置入口 | `TBD` | Project extension | Draft |
| `ROUTE-007` | `/settings/providers` | Provider 设置 | Provider | 设置导航 | `/settings` | Project extension | Draft |
| `ROUTE-008` | `/settings/storage` | 存储设置 | Storage | 设置导航 | `/settings` | Project extension | Draft |
| `ROUTE-009` | `/settings/pwa` | PWA 设置 | PWA settings | 设置导航 | `/settings` | Project extension | Draft |

## App Shell 区域清单

以下区域来自 PLAN 的产品约束；具体顺序、尺寸、显隐和控件组成仍需参考证据。

| Region ID | 区域 | Desktop 预期 | Mobile 预期 | 内容责任 | Reference ID | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `REGION-001` | 全局导航 | 窄 Rail；展开/收起待测 | 简洁顶部栏/入口待测 | 主路由与全局动作 | `TBD` | Draft |
| `REGION-002` | 顶部控制 | 极轻量 | 简洁顶部栏 | 页面上下文、过滤或动作 `TBD` | `TBD` | Draft |
| `REGION-003` | 主画廊 | 全高沉浸式瀑布流 | 紧凑双列或参考比例布局 | Asset 与 Job 状态 | `TBD` | Draft |
| `REGION-004` | Composer | 底部居中悬浮 | 底部安全区 | Prompt、模式、参数、附件、提交 | `TBD` | Draft |
| `REGION-005` | 参数层 | Popover/Sheet `TBD` | Bottom Sheet | Capability 驱动参数 | `TBD` | Draft |
| `REGION-006` | Viewer | 全屏 Overlay | 全屏，可左右滑动 | 媒体查看和后续动作 | `TBD` | Draft |
| `REGION-007` | 系统反馈 | Toast/状态反馈 `TBD` | Toast/状态反馈 `TBD` | 错误、更新、成功、离线 | `TBD` | Draft |

## 内容对象关系

```text
GenerationRequest -> Job -> Asset
Asset -> Saved state
Asset <-> Collection
Asset -> Parent asset (edit/reference/image-to-video)
Provider -> Model -> Capability -> Composer controls
```

此关系只说明产品对象，不规定 UI 组件树或页面级 Store。

## 页面结构模板

对每个路由复制下表并填写。`Order` 只在证据确认后填写。

| Route ID | Order | Region ID | Landmark/语义 | Primary content | Empty state | Loading state | Error state | 权限/能力条件 | Reference ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## 导航关系模板

| From | Trigger | To/Overlay | URL 变化 | History 行为 | Focus 目标 | Mobile 差异 | Reference ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## 命名与扩展原则

- 参考站点可观察的信息架构优先于旧项目结构。
- 设置、Provider、存储和 PWA 等新增能力应自然扩展，而不挤压主画廊或形成永久参数面板。
- 高级参数默认进入 Popover/Sheet；实际载体按响应式证据填写。
- 不复制 Grok 品牌命名。面向用户的最终文案单独评审。
- 可访问性语义必须记录，但不能用来臆造视觉布局。

## 未决问题

| Question ID | 问题 | 所需证据 | Owner | 截止 PR | Decision |
| --- | --- | --- | --- | --- | --- |
| `IA-Q-001` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
