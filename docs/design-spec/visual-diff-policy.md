# Visual Diff Policy

本策略用于 UI PR 的可重复视觉验收。私有 Grok 参考截图仅在本机用于人工测量和对比，不得进入 Git、CI artifact 或 PR 描述。

## 固定环境

| Item | Frozen value | 状态 |
| --- | --- | --- |
| UI reference date | `2026-08-24` | Frozen |
| UI reference target | `https://grok.com/imagine` | Frozen |
| Mock fixture version | `pr1-v1` | Frozen for PR 1 |
| Browser + version | Playwright 1.62.1 bundled Chromium | Frozen by lockfile/Actions |
| OS/container image | `ubuntu-24.04` GitHub-hosted runner | Frozen by workflow |
| Font files/version | Runner system UI stack; no remote font | Frozen by environment |
| Color scheme | Light | Frozen for PR 1 |
| Locale/timezone | `en-US` / UTC fixture timestamps | Frozen for PR 1 |
| DPR | `1` | Frozen for PR 1 |
| Animation policy | CSS animations disabled at screenshot time | Frozen for PR 1 |

## 必交视口

每个 UI PR 至少提交：

```text
artifacts/visual/<pr-number>/
├── desktop-1440x900.png
├── desktop-1920x1080.png
├── mobile-390x844.png
├── mobile-430x932.png
└── visual-diff-report.md
```

涉及对应断点或回归时，补充 1280x800、1024x1366、834x1194 和 360x800。

## Baseline 规则

1. 使用固定 Mock 数据、固定媒体、固定字体和固定浏览器环境。
2. Baseline 必须对应已审阅 Surface ID 和交互稳定状态。
3. 更新 Baseline 必须由功能变更与规格变更共同解释，不能用更新截图掩盖回归。
4. 参考站点更新不会自动更新 Baseline；先走 `ui-reference-version.md` 变更流程。
5. 基线与实现截图不得包含 Secret、真实用户数据、登录态内容或私有参考素材。

## 区域分类与阈值

| Region class | 例子 | 比较方式 | 阈值/规则 |
| --- | --- | --- | --- |
| Stable core | Shell、Composer、菜单、控件 | Pixel diff + geometry | 像素差异 <=2%；几何 <=4px |
| Stable detail | 圆角、间距、控件高度 | Geometry/style assertion | 误差 <=3px |
| Dynamic media | 图片、视频帧、时间、随机内容 | Mask | 必须显式声明 mask |
| Motion | Sheet/Viewer 动画 | Stable frame + interaction evidence | 按 `motion.md` |
| Safe area | Mobile Composer/system inset | Device-specific geometry | 必须逐设备确认 |

阈值是拒绝明显偏差的下限，不代表达到阈值即自动通过 L3/L4。

## Mask 登记

| Mask ID | Surface ID | Selector/box | 原因 | 范围是否最小 | Owner | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| `MASK-TBD-001` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

- Mask 只能排除真正动态内容，不能遮罩 Shell、布局、Composer、菜单或状态反馈。
- Mask 新增或扩大必须在 PR 报告中说明。

## 截图稳定条件

截图前必须满足：

- 字体和固定 Mock 媒体加载完成；
- 网络请求进入预期静止状态；
- 滚动位置、焦点、Hover、Overlay 和任务状态已显式设置；
- 动效完成或依据冻结策略暂停到指定帧；
- 日期、时间、随机 ID 和进度由 Fixture 固定；
- 浏览器缩放、DPR、主题、语言和时区与基线一致。

## 差异报告模板

```markdown
# Visual Diff Report - PR <number>

- Reference version: 2026-08-24
- Mock fixture: TBD
- Browser/font environment: TBD
- Tested Surface IDs: TBD

| Viewport | Baseline | Actual | Pixel diff | Geometry diff | Masks | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1440x900 | TBD | TBD | TBD | TBD | TBD | TBD |

## Reference states

仅列 Reference ID 和推导规格，不嵌入私有截图。

## Known differences

| Difference | Intentional | Spec/issue | Owner | Follow-up |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

## Interaction verification

| Interaction ID | Desktop | Mobile | Result |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |
```

## 评审结论

| Result | 条件 |
| --- | --- |
| Pass | 阈值内，关键交互匹配，无未声明偏差 |
| Pass with intentional diff | 偏差有规格依据、审阅人和后续策略 |
| Fail | 超阈值、关键路径不符、Mask 滥用或环境不可重复 |

所有关键交互路径还必须与 `interaction-map.md` 一致。功能通过不能替代视觉通过。
