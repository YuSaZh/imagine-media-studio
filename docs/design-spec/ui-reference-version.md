# UI Reference Version

## 冻结基准

```text
UI_REFERENCE_DATE=2026-08-24
UI_REFERENCE_TARGET=https://grok.com/imagine
REFERENCE_PACKAGE=.design-reference/grok-imagine-2026-08-24/
PUBLIC_REFERENCE_PACKAGE=.design-reference/grok-imagine-public-2026-08-25/
```

Grok Imagine 是本项目 UI/UX 的唯一基准。此冻结记录用于阻止目标网站后续变化无意改变当前迭代。PR 0 只建立参考制度和填写模板，不声明任何尚未由参考证据确认的最终 UI。

2026-08-25 增加了一个公开未登录补充包。它只支持 [`pr1-public-reference.md`](./pr1-public-reference.md) 记录的有限静态规格，不改变完整冻结基准，也不代表登录后界面已经捕获。

## 使用边界

- 可以提交：由私有参考截图推导出的尺寸、状态、行为、Token、文字描述和差异结论。
- 不得提交：私有截图、录屏、登录态素材、Cookie、Token、用户内容、Grok Logo、品牌专用素材、专有插画或原始图标文件。
- 不得凭记忆补全参考站点行为。无法由证据确认的字段填写 `TBD`。
- 不得把 `gpt_image_playground` 或其他捐赠项目的页面与视觉当作参考。
- 产品名称、Logo、图标、演示素材和品牌文案必须使用本项目自有资产。

## 参考包登记

私有参考包只存在于本机 `.design-reference/`，不进入 Git。每次采集后在下表登记元数据，不粘贴截图内容。

| Reference ID | 设备/视口 | 页面或状态 | 采集时间 | 登录态 | 主题/语言 | 文件相对路径 | 已脱敏 | 记录人 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REF-PR1-PUBLIC-DESKTOP-BASE-001` | Desktop / 1440x900 | 公开首页 / 默认图片 Composer | 2026-08-25 | 未登录 | 浅色 / 中文界面 | `desktop-1440x900.png` | 是 | Codex | 仅公开未登录补充证据 |
| `REF-PR1-PUBLIC-DESKTOP-COUNT-002` | Desktop / 1440x900 | 图片数量菜单打开 | 2026-08-25 | 未登录 | 浅色 / 中文界面 | `desktop-image-count-1440x900.png` | 是 | Codex | 与默认状态形成有限 E2 |
| `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | Desktop / 1440x900 | 图片比例菜单打开 | 2026-08-25 | 未登录 | 浅色 / 中文界面 | `desktop-aspect-ratio-1440x900.png` | 是 | Codex | 与默认状态形成有限 E2 |
| `REF-PR1-PUBLIC-MOBILE-BASE-004` | Mobile / 390x844 | 公开首页 / 手机布局 | 2026-08-25 | 未登录 | 浅色 / 中文界面 | `mobile-390x844.png` | 是 | Codex | 不证明 standalone 或设备安全区 |

文件相对路径只写相对于该条目所属 `REFERENCE_PACKAGE` 或 `PUBLIC_REFERENCE_PACKAGE` 的路径，不写本机绝对路径。

## 证据质量

每项规格必须标记下列一种证据等级：

| 等级 | 定义 | 可否冻结实现 |
| --- | --- | --- |
| `E0` | 无截图或录屏，仅有假设 | 否 |
| `E1` | 单一静态截图可观察 | 仅可冻结静态外观 |
| `E2` | 多视口或前后状态证据 | 可冻结响应式或状态变化 |
| `E3` | 录屏、计时或完整交互路径证据 | 可冻结交互与动效 |

## 规格冻结清单

| Spec | Owner | Evidence | 状态 | 冻结日期 | 变更记录 |
| --- | --- | --- | --- | --- | --- |
| `screen-matrix.md` | `TBD` | `E2`（有限公开状态） | Draft | - | 2026-08-25 登记公开未登录补充证据 |
| `information-architecture.md` | `TBD` | `E0` | Draft | - | - |
| `interaction-map.md` | `TBD` | `E0` | Draft | - | - |
| `responsive-map.md` | `TBD` | `E2`（仅 1440/390） | Draft | - | 2026-08-25 记录有限静态重排关系 |
| `geometry.md` | `TBD` | `E1`（近似测量） | Measured | - | 2026-08-25 记录公开 Composer/控件几何 |
| `tokens.md` | `TBD` | `E0` | Draft | - | - |
| `motion.md` | `TBD` | `E0` | Draft | - | - |
| `visual-diff-policy.md` | `TBD` | `E0` | Draft | - | - |

允许状态：`Draft`、`Measured`、`Reviewed`、`Frozen`。只有证据充分且完成双人复核的条目可标为 `Frozen`。

## 参考版本变更流程

1. 新建独立参考包，不覆盖 `grok-imagine-2026-08-24`。
2. 记录新目标、日期、视口、环境和完整状态矩阵。
3. 对比信息架构、几何、交互、响应式和动效变化。
4. 单独评审迁移范围和破坏性影响。
5. 评审通过后更新冻结常量、相关规格和视觉基线。

不得仅因在线目标发生变化而自动更新当前规格。
