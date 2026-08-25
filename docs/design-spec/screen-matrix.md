# Screen Matrix

本文件记录必须采集、实现和验收的页面状态。PR 0 仅冻结清单；`Reference ID`、实际行为和实现状态由后续参考采集与 UI PR 填写。

## 字段规则

- `Surface ID`：稳定标识，格式 `SURFACE-<AREA>-<NNN>`。
- `Reference ID`：对应 `ui-reference-version.md` 的私有证据登记项。
- `Evidence`：`E0` 至 `E3`。
- `Status`：`Missing`、`Captured`、`Specified`、`Implemented`、`Verified`。
- `Dynamic mask`：视觉回归时需排除的动态区域；无则填 `None`。
- 未确认内容统一填 `TBD`，不凭印象填写。

## 公开未登录补充证据

这些 Surface 只登记公开页面中实际捕获的状态，用于约束有限布局关系。它们不等同于登录后的产品 Surface，也不能替代下方完整状态矩阵。

| Surface ID | 页面/状态 | 目标视口 | Reference ID | Evidence | Dynamic mask | Status | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SURFACE-PUBLIC-DESKTOP-001` | 未登录公开首页 / 默认图片 Composer / 模板画廊 | 1440x900 | `REF-PR1-PUBLIC-DESKTOP-BASE-001` | `E1` | public media | Captured | 支持白色画布、居中双层 Composer 和紧凑瀑布流；不支持登录后 Shell |
| `SURFACE-PUBLIC-DESKTOP-002` | 图片数量菜单打开 | 1440x900 | `REF-PR1-PUBLIC-DESKTOP-COUNT-002` | `E2` | public media | Captured | 只支持自动、2、4、8、12 的静态选项与锚定位置 |
| `SURFACE-PUBLIC-DESKTOP-003` | 图片比例菜单打开 | 1440x900 | `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | `E2` | public media | Captured | 只支持 2:3、3:2、1:1、9:16、16:9 的静态选项与锚定位置 |
| `SURFACE-PUBLIC-MOBILE-001` | 未登录公开首页 / 双列模板画廊 / 底部 Composer | 390x844 | `REF-PR1-PUBLIC-MOBILE-BASE-004` | `E1` | public media / browser chrome unknown | Captured | 不证明 PWA standalone、软键盘或安全区数值 |

## 桌面端必采状态

| Surface ID | 页面/状态 | 目标视口 | Reference ID | Evidence | Dynamic mask | Status | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SURFACE-DESKTOP-001` | 首次进入/空画廊 | 1920x1080, 1440x900 | `TBD` | `E0` | `TBD` | Missing | `TBD` |
| `SURFACE-DESKTOP-002` | 有历史内容的主画廊 | 1920x1080, 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-003` | 左侧导航展开 | 1440x900 | `TBD` | `E0` | `TBD` | Missing | `TBD` |
| `SURFACE-DESKTOP-004` | 左侧导航收起 | 1440x900 | `TBD` | `E0` | `TBD` | Missing | `TBD` |
| `SURFACE-DESKTOP-005` | 图片模式 Composer | 1440x900 | `TBD` | `E0` | None | Missing | `TBD` |
| `SURFACE-DESKTOP-006` | 视频模式 Composer | 1440x900 | `TBD` | `E0` | None | Missing | `TBD` |
| `SURFACE-DESKTOP-007` | 比例/模式/模型选择层 | 1440x900 | `TBD` | `E0` | None | Missing | `TBD` |
| `SURFACE-DESKTOP-008` | 上传参考图后的 Composer | 1440x900 | `TBD` | `E0` | reference media | Missing | `TBD` |
| `SURFACE-DESKTOP-009` | 单图生成中 | 1440x900 | `TBD` | `E0` | progress/media | Missing | `TBD` |
| `SURFACE-DESKTOP-010` | 多图生成中 | 1440x900 | `TBD` | `E0` | progress/media | Missing | `TBD` |
| `SURFACE-DESKTOP-011` | 视频生成中 | 1440x900 | `TBD` | `E0` | progress/media | Missing | `TBD` |
| `SURFACE-DESKTOP-012` | 失败状态 | 1440x900 | `TBD` | `E0` | None | Missing | 与拒绝分开采集 |
| `SURFACE-DESKTOP-013` | 拒绝状态 | 1440x900 | `TBD` | `E0` | None | Missing | 与失败分开采集 |
| `SURFACE-DESKTOP-014` | 图片 Viewer | 1920x1080, 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-015` | 视频 Viewer | 1920x1080, 1440x900 | `TBD` | `E0` | video/time | Missing | `TBD` |
| `SURFACE-DESKTOP-016` | 图片编辑入口 | 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-017` | 图片转视频入口 | 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-018` | Saved/收藏页 | 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-019` | 文件夹或集合页 | 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-020` | 多选状态 | 1440x900 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-DESKTOP-021` | 加载更多状态 | 1440x900 | `TBD` | `E0` | media/progress | Missing | `TBD` |
| `SURFACE-DESKTOP-022` | 断网状态 | 1440x900 | `TBD` | `E0` | None | Missing | 与接口错误分开采集 |
| `SURFACE-DESKTOP-023` | 接口错误状态 | 1440x900 | `TBD` | `E0` | None | Missing | 与断网分开采集 |

## 手机端必采状态

| Surface ID | 页面/状态 | 目标视口 | Reference ID | Evidence | Dynamic mask | Status | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SURFACE-MOBILE-001` | 主画廊 | 430x932, 390x844, 360x800 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-MOBILE-002` | Composer 收起 | 430x932, 390x844 | `TBD` | `E0` | None | Missing | `TBD` |
| `SURFACE-MOBILE-003` | Composer 输入中 | 430x932, 390x844 | `TBD` | `E0` | cursor | Missing | `TBD` |
| `SURFACE-MOBILE-004` | 软键盘弹出 | 430x932, 390x844 | `TBD` | `E0` | OS keyboard | Missing | 记录 `visualViewport` |
| `SURFACE-MOBILE-005` | 参考图横向条 | 430x932, 390x844 | `TBD` | `E0` | reference media | Missing | `TBD` |
| `SURFACE-MOBILE-006` | 参数 Bottom Sheet | 430x932, 390x844 | `TBD` | `E0` | None | Missing | `TBD` |
| `SURFACE-MOBILE-007` | 图片/视频切换 | 430x932, 390x844 | `TBD` | `E0` | None | Missing | 需前后状态证据 |
| `SURFACE-MOBILE-008` | 图片 Viewer | 430x932, 390x844 | `TBD` | `E0` | media | Missing | `TBD` |
| `SURFACE-MOBILE-009` | 视频 Viewer | 430x932, 390x844 | `TBD` | `E0` | video/time | Missing | `TBD` |
| `SURFACE-MOBILE-010` | 长按多选 | 430x932, 390x844 | `TBD` | `E0` | media | Missing | 需录屏/计时证据 |
| `SURFACE-MOBILE-011` | PWA standalone | 430x932, 390x844 | `TBD` | `E0` | OS chrome | Missing | 不模拟浏览器标题栏 |
| `SURFACE-MOBILE-012` | iPhone 安全区 | 390x844 | `TBD` | `E0` | OS chrome | Missing | 记录 top/bottom inset |
| `SURFACE-MOBILE-013` | Android 安装后窗口 | 430x932, 360x800 | `TBD` | `E0` | OS chrome | Missing | `TBD` |

## 项目新增页面

设置页等项目独有界面没有 Grok 对应页面时，仍沿用已冻结 Token 与交互语言，但必须标记为 `Project extension`，不得伪称参考站点复刻。

| Surface ID | 路由 | 页面/状态 | 来源 | 目标视口 | Spec 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `SURFACE-PROJECT-001` | `/settings` | 设置入口 | Project extension | Desktop + Mobile | Draft | `TBD` |
| `SURFACE-PROJECT-002` | `/settings/providers` | Provider 设置 | Project extension | Desktop + Mobile | Draft | `TBD` |
| `SURFACE-PROJECT-003` | `/settings/storage` | 存储设置 | Project extension | Desktop + Mobile | Draft | `TBD` |
| `SURFACE-PROJECT-004` | `/settings/pwa` | PWA 设置 | Project extension | Desktop + Mobile | Draft | `TBD` |
| `SURFACE-PROJECT-005` | `/jobs` | 全部任务/二级入口 | Project extension | Desktop + Mobile | Draft | 可隐藏 |

## PR 验收记录

| PR | Surface ID | 实现截图 | Reference ID | Diff report | 结论 | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| `PR 1` | Desktop/mobile Shell, Gallery, Composer, Viewer, Library, Settings | 1920x1080, 1440x900, 430x932, 390x844 | Public supplement only; authenticated IDs `TBD` | `pr1-visual-diff-report.md` | Local preflight; remote CI and L3/L4 Gate pending | Automated checks + local Codex visual review |
