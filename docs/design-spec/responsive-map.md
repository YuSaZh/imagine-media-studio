# Responsive Map

手机端是独立响应式设计，不是桌面缩放版。断点必须从参考证据和内容适配推导，不在 PR 0 臆造固定断点。

## 固定参考视口

| Viewport ID | CSS viewport | 分类 | 必测重点 | Reference ID | 状态 |
| --- | --- | --- | --- | --- | --- |
| `VP-DESKTOP-WIDE` | 1920x1080 | 桌面宽屏 | App Shell、画廊、Viewer | `TBD` | Missing |
| `VP-DESKTOP` | 1440x900 | 常用桌面 | 全部核心路径 | `REF-PR1-PUBLIC-DESKTOP-BASE-001` | Partial - public unauthenticated only |
| `VP-LAPTOP` | 1280x800 | 小型笔记本 | 高度受限、Composer 遮挡 | `TBD` | Missing |
| `VP-TABLET-1024` | 1024x1366 | 平板竖屏 | 导航转换、画廊列数 | `TBD` | Missing |
| `VP-TABLET-834` | 834x1194 | 平板竖屏 | 导航、Sheet、触摸目标 | `TBD` | Missing |
| `VP-MOBILE-LARGE` | 430x932 | 大屏手机 | 安全区、Composer、Viewer | `TBD` | Missing |
| `VP-MOBILE` | 390x844 | 常见手机 | 全部手机核心路径 | `REF-PR1-PUBLIC-MOBILE-BASE-004` | Partial - public unauthenticated only |
| `VP-MOBILE-SMALL` | 360x800 | 小屏手机 | 文本溢出、可用高度 | `TBD` | Missing |

## 响应式区域模板

每个区域至少填写一个桌面、一个平板和一个手机证据。`Mode` 可用：`fixed`、`fluid`、`reflow`、`replace`、`hide`、`overlay`。

| Region/Component | 宽度区间或条件 | Mode | 尺寸/定位 | 内容变化 | 交互变化 | Reference ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Navigation | `TBD` | `TBD` | Desktop Rail / Mobile `TBD` | `TBD` | `TBD` | `TBD` | `E0` |
| Top controls | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` |
| Gallery | 1440x900 -> 390x844 静态对照 | reflow | 公开模板区：桌面居中三列可见；手机近全宽双列；精确 gap `TBD` | 卡片比例混排保持 | 手势/加载 `TBD` | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-MOBILE-BASE-004` | `E2` |
| Composer | 1440x900 -> 390x844 静态对照 | reflow | 公开页面：桌面约 768px 居中；手机近全宽底部浮层 | 两层结构保留；完整控件差异 `TBD` | 键盘/展开/提交 `TBD` | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-MOBILE-BASE-004` | `E2` |
| Parameter controls | Desktop 1440x900 only | overlay | 数量和比例菜单锚定在对应控件上方；手机载体 `TBD` | 数量与比例选项已记录 | 打开/关闭/焦点 `TBD` | `REF-PR1-PUBLIC-DESKTOP-COUNT-002`, `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | `E2` |
| Reference strip | `TBD` | reflow | Mobile horizontal strip | `TBD` | 横向滚动 `TBD` | `TBD` | `E0` |
| Viewer | `TBD` | fluid | Full-screen | 工具栏 `TBD` | Desktop keys / Mobile gesture | `TBD` | `E0` |
| Toast/update | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` |

## Breakpoint 推导记录

| Breakpoint ID | 范围 | 触发原因 | 前一布局 | 后一布局 | 最小内容宽度 | Reference IDs | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BP-TBD-001` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | Draft |

断点应由布局真实发生变化的位置决定，不能直接套用框架默认值。

## 安全区与软键盘

| Scenario | Viewport/Device | `safe-area-inset-top` | `safe-area-inset-bottom` | visual viewport height | Composer bottom | 遮挡/滚动行为 | Reference ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone browser | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| iPhone standalone | 390x844 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Android browser | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Android installed | 430x932 / 360x800 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Soft keyboard open | 430x932 / 390x844 | N/A | `TBD` | `TBD` | `TBD` | Composer 不得被遮挡 | `TBD` |
| Public mobile capture | 390x844 | `TBD` | `TBD` | `TBD` | 底部可见避让空间，数值 `TBD` | 不能判定浏览器/standalone/键盘行为 | `REF-PR1-PUBLIC-MOBILE-BASE-004` |

## 内容压力测试

每个固定视口还需验证：

| Case | 期望 | Desktop | Tablet | Mobile | 结论 |
| --- | --- | --- | --- | --- | --- |
| 最长本地化文案 | 不重叠、不截断关键动作 | `TBD` | `TBD` | `TBD` | `TBD` |
| 200% 浏览器缩放 | 核心流程仍可操作 | `TBD` | N/A | N/A | `TBD` |
| 大字体/系统字号 | 控件可重排 | N/A | `TBD` | `TBD` | `TBD` |
| 多参考图 | 条带稳定且可滚动 | `TBD` | `TBD` | `TBD` | `TBD` |
| 最长模型/Profile 名称 | 不挤压提交动作 | `TBD` | `TBD` | `TBD` | `TBD` |
| 画廊混合比例媒体 | 预留比例，无大面积跳动 | `TBD` | `TBD` | `TBD` | `TBD` |
