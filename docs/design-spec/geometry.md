# Geometry

最终几何值必须从冻结参考截图测量，并关联 Reference ID。公开补充截图只允许记录明确标为 Draft 的近似值；PR 0 示例中的 `TBD` 不是实现默认值。

## 测量规范

1. 使用 CSS pixel 记录，保留截图原始视口和设备像素比。
2. 测量前确认页面缩放、浏览器 UI、滚动位置、主题、字体加载和登录态。
3. 每项至少记录两次测量；差异超过 2px 时复核截图或布局状态。
4. 流式值记录 `min / preferred / max` 或计算关系，不把单张截图值误当常量。
5. 从截图无法确定的值填 `TBD`，并写明需要的补充证据。

## 测量环境

| Measurement ID | Reference ID | Viewport | DPR | Browser zoom | Font status | Scroll position | Recorder |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `MEASURE-PR1-PUBLIC-DESKTOP-001` | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-DESKTOP-COUNT-002`, `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | 1440x900 | `TBD` | `TBD` | 已渲染，字体身份 `TBD` | 截图所示位置 | Codex |
| `MEASURE-PR1-PUBLIC-MOBILE-002` | `REF-PR1-PUBLIC-MOBILE-BASE-004` | 390x844 | `TBD` | `TBD` | 已渲染，字体身份 `TBD` | 截图所示位置 | Codex |

## App Shell 几何

| Geometry ID | Region/Element | Viewport/condition | Property | Value (CSS px/formula) | Tolerance | Reference ID | Evidence | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GEO-SHELL-001` | Navigation rail | Desktop expanded | width | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-002` | Navigation rail | Desktop collapsed | width | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-003` | Top controls | Desktop | height/inset | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-004` | Main content | Desktop | insets/max-width | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-005` | Composer | Desktop | width/height/bottom | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-006` | Composer | Mobile collapsed | width/height/bottom | `TBD` | <=4px | `TBD` | `E0` | Draft |
| `GEO-SHELL-007` | Composer | Mobile expanded/keyboard | width/height/bottom | `TBD` | <=4px | `TBD` | `E0` | Draft |

## 组件几何模板

| Geometry ID | Component/state | Property | Desktop | Tablet | Mobile | Tolerance | Reference IDs | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GEO-GALLERY-001` | Gallery | columns | 3 visible（公开模板） | `TBD` | 2（公开模板） | Exact | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-MOBILE-BASE-004` | Draft |
| `GEO-GALLERY-002` | Gallery | column width/gap | `TBD` | `TBD` | `TBD` | <=4px | `TBD` | Draft |
| `GEO-CARD-001` | Media card | radius | `TBD` | `TBD` | `TBD` | <=3px | `TBD` | Draft |
| `GEO-CARD-002` | Media card | overlay inset | `TBD` | `TBD` | `TBD` | <=3px | `TBD` | Draft |
| `GEO-COMPOSER-001` | Composer | radius/padding/gap | `TBD` | `TBD` | `TBD` | <=3px | `TBD` | Draft |
| `GEO-CONTROL-001` | Upload/submit icon button | size/hit area | 约 36x36 | `TBD` | 约 36x36 | <=3px | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-MOBILE-BASE-004` | Draft |
| `GEO-CONTROL-002` | Image count control | size | 约 101x36 | `TBD` | `TBD` | <=3px | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-DESKTOP-COUNT-002` | Draft |
| `GEO-CONTROL-003` | Aspect ratio control | size | 约 67x36 | `TBD` | `TBD` | <=3px | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | Draft |
| `GEO-OVERLAY-001` | Popover | width/padding/offset | `TBD` | `TBD` | N/A `TBD` | <=4px | `TBD` | Draft |
| `GEO-SHEET-001` | Bottom Sheet | width/max-height/radius | N/A `TBD` | `TBD` | `TBD` | <=4px | `TBD` | Draft |
| `GEO-VIEWER-001` | Viewer media | fit/insets | `TBD` | `TBD` | `TBD` | <=4px | `TBD` | Draft |
| `GEO-TOAST-001` | Toast | width/insets | `TBD` | `TBD` | `TBD` | <=4px | `TBD` | Draft |

## 公开页面临时几何

这些值用于 PR 1 的早期公共证据实现，不表示登录后 Shell 已冻结。

| Geometry ID | Region/Element | Viewport | Value | Reference ID | Evidence | 状态/限制 |
| --- | --- | --- | --- | --- | --- | --- |
| `GEO-PUBLIC-COMPOSER-001` | 双层 Composer | 1440x900 | 宽约 768px，水平居中；Prompt 行在上、控件行在下 | `REF-PR1-PUBLIC-DESKTOP-BASE-001` | `E1` | Draft；高度、圆角、padding 仍需复测 |
| `GEO-PUBLIC-COMPOSER-002` | 双层 Composer | 390x844 | 近全宽底部浮层，左右约 20px，底部有可见避让空间 | `REF-PR1-PUBLIC-MOBILE-BASE-004` | `E1` | Draft；不等同已确认 safe-area inset |
| `GEO-PUBLIC-GALLERY-001` | 公开模板瀑布流 | 1440x900 / 390x844 | 桌面居中三列可见；手机近全宽双列 | `REF-PR1-PUBLIC-DESKTOP-BASE-001`, `REF-PR1-PUBLIC-MOBILE-BASE-004` | `E2` | Draft；精确列宽、gap 和断点 `TBD` |

## 空间关系记录

| Relationship ID | A | B | 关系 | Desktop | Mobile | Reference IDs | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-TBD-001` | `TBD` | `TBD` | gap/alignment/overlap | `TBD` | `TBD` | `TBD` | `TBD` |

## 几何验收

- 关键几何尺寸误差原则上不超过 4px。
- 圆角、间距和控件高度误差原则上不超过 3px。
- 手机安全区和 Composer 底部位置必须逐设备确认。
- 媒体加载前使用已知比例预留空间，避免大面积布局跳动。
- 超出阈值必须在视觉差异报告中标记为有意差异或缺陷，不能静默接受。
