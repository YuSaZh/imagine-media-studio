# Design Tokens

最终 Token 将实现于 `apps/web/src/styles/tokens.css`。本文件先定义测量、命名和审批方式；PR 0 不发明颜色、字体、圆角、阴影或最终数值。

## Token 原则

- 三层命名：primitive -> semantic -> component（仅在组件确有专属语义时增加 component 层）。
- 组件优先消费 semantic token，不散落随意 hex、px、duration 或 z-index。
- 每个参考派生值必须关联 Reference ID；项目品牌值标记 `Project-owned`。
- 状态不能只依赖颜色；同时提供图标、文字、形状或位置反馈。
- 未测量值使用 `TBD`，不得把模板占位当作实现默认值。

## Primitive Token 模板

| Token | Category | Raw value | Unit/format | Source | Reference ID | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `--primitive-color-tbd` | color | `TBD` | OKLCH/hex `TBD` | Reference-derived | `TBD` | Draft |
| `--primitive-space-tbd` | spacing | `TBD` | px/rem `TBD` | Reference-derived | `TBD` | Draft |
| `--primitive-radius-tbd` | radius | `TBD` | px/rem `TBD` | Reference-derived | `TBD` | Draft |
| `--primitive-font-size-tbd` | typography | `TBD` | rem `TBD` | Reference-derived | `TBD` | Draft |
| `--primitive-duration-tbd` | motion | `TBD` | ms | Reference-derived | `TBD` | Draft |

## Semantic Token 清单

| Token | Purpose | Light | Dark/default | Fallback | Contrast target | Reference ID | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--color-bg-canvas` | 最底层背景 | `TBD` | `TBD` | `TBD` | N/A | `TBD` | Draft |
| `--color-bg-surface` | 表面层 | `TBD` | `TBD` | `TBD` | N/A | `TBD` | Draft |
| `--color-bg-overlay` | Overlay/浮层 | `TBD` | `TBD` | `TBD` | N/A | `TBD` | Draft |
| `--color-border-subtle` | 弱边框 | `TBD` | `TBD` | `TBD` | 可辨识 | `TBD` | Draft |
| `--color-border-strong` | 强调边框 | `TBD` | `TBD` | `TBD` | 可辨识 | `TBD` | Draft |
| `--color-text-primary` | 主要文本 | `TBD` | `TBD` | `TBD` | WCAG target `TBD` | `TBD` | Draft |
| `--color-text-muted` | 弱化文本 | `TBD` | `TBD` | `TBD` | WCAG target `TBD` | `TBD` | Draft |
| `--color-interactive-hover` | Hover | `TBD` | `TBD` | `TBD` | N/A | `TBD` | Draft |
| `--color-interactive-active` | Active/selected | `TBD` | `TBD` | `TBD` | 状态可辨识 | `TBD` | Draft |
| `--color-focus-ring` | Keyboard focus | `TBD` | `TBD` | `TBD` | 3:1 target `TBD` | Project-owned + aligned | `TBD` | Draft |
| `--color-status-danger` | 失败/危险 | `TBD` | `TBD` | `TBD` | WCAG target `TBD` | `TBD` | Draft |
| `--color-status-warning` | 警告/不兼容 | `TBD` | `TBD` | `TBD` | WCAG target `TBD` | `TBD` | Draft |
| `--color-status-success` | 成功 | `TBD` | `TBD` | `TBD` | WCAG target `TBD` | `TBD` | Draft |

## 尺寸与层级 Token 清单

| Token group | Required tokens | Scale/relationship | Reference IDs | 状态 |
| --- | --- | --- | --- | --- |
| Spacing | `--space-*` | `TBD` | `TBD` | Draft |
| Radius | `--radius-*` | `TBD` | `TBD` | Draft |
| Typography | family, size, line-height, weight | `TBD` | `TBD` | Draft |
| Shadow | surface, popover, viewer, focus | `TBD` | `TBD` | Draft |
| Control size | compact, default, touch | `TBD` | `TBD` | Draft |
| Z-index | canvas, rail, composer, popover, sheet, viewer, toast | 明确有序，不使用随机大值 | `TBD` | Draft |
| Motion | duration, easing | 由 `motion.md` 冻结 | `TBD` | Draft |

## Component Token 申请模板

只有 semantic token 无法准确表达且至少两个状态共享时，才新增 component token。

| Proposed token | Component | Why semantic token is insufficient | States | Reference IDs | Reviewer | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## 字体与图标

| Asset type | Family/source | License | Loading/fallback | Metrics tested | Brand-safe | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| UI font | `TBD` | `TBD` | `TBD` | `TBD` | Yes `TBD` | Draft |
| Icons | Project-owned/library `TBD` | `TBD` | `TBD` | N/A | 必须为 Yes | Draft |

不得复制 Grok 原始图标文件、Logo 或品牌专用素材。

## Token 验收

- 固定字体环境用于视觉基线。
- 关键前景/背景组合记录实际对比度。
- Hover、Active、Focus、Disabled、Danger 状态逐一截图验证。
- Token 变化必须在视觉差异报告中列出影响面。
