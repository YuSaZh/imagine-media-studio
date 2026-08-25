# PR 1 Public Reference Supplement

## Purpose

本文件记录 2026-08-25 可公开访问、未登录的 Grok Imagine 页面证据。它是 PR 1 的有限补充，不替代冻结的完整参考包，也不证明登录后的 App Shell、任务工作流或项目级页面。

证据包只保存在本机：

```text
.design-reference/grok-imagine-public-2026-08-25/
```

截图不得提交到仓库、CI artifact 或 PR 描述。下文只登记相对文件名和由截图直接支持的规格。

## Evidence Register

| Reference ID | File | Viewport | State | Evidence | Scope |
| --- | --- | --- | --- | --- | --- |
| `REF-PR1-PUBLIC-DESKTOP-BASE-001` | `desktop-1440x900.png` | 1440x900 | 未登录公开首页，默认图片 Composer | `E1` | 静态布局、公开模板画廊、默认控件 |
| `REF-PR1-PUBLIC-DESKTOP-COUNT-002` | `desktop-image-count-1440x900.png` | 1440x900 | 图片数量菜单打开 | `E2` | 与默认状态对照后的数量菜单内容和锚定关系 |
| `REF-PR1-PUBLIC-DESKTOP-RATIO-003` | `desktop-aspect-ratio-1440x900.png` | 1440x900 | 图片比例菜单打开 | `E2` | 与默认状态对照后的比例菜单内容和锚定关系 |
| `REF-PR1-PUBLIC-MOBILE-BASE-004` | `mobile-390x844.png` | 390x844 | 未登录公开首页，手机布局 | `E1` | 双列公开画廊、底部 Composer 静态位置 |

`E2` 仅表示有默认/打开状态或桌面/手机的静态对照，不表示菜单交互、响应动画或断点已经冻结。

## Directly Observed Desktop Evidence

在 1440x900 公开未登录页面中可以直接观察到：

- 页面使用白色画布，主要创作区域居中，公开模板画廊位于 Composer 下方。
- Composer 约 768px 宽，呈上下两层：上层是 Prompt 输入区，下层是模式和参数控件。
- 上传按钮与提交按钮均为约 36x36px 的圆形控件。
- 图片数量控件约 101x36px；默认值为自动模式，菜单列出自动、2、4、8、12。
- 图片比例控件约 67x36px；菜单列出 2:3、3:2、1:1、9:16、16:9。
- 数量和比例菜单在对应控件上方展开，并保持紧凑的单列选项布局。
- 公开模板区是紧凑的瀑布流式画廊，混合多种卡片比例，卡片标签位于媒体底部。

这些数值来自单一视口截图测量，均为近似值。真实 CSS token、字体、DPR、浏览器缩放、Hover、Focus 和动画仍为 `TBD`。

## Directly Observed Mobile Evidence

在 390x844 公开未登录页面中可以直接观察到：

- 公开模板画廊重排为双列，卡片比例继续混排。
- Composer 变为接近视口全宽的底部浮层，保留上下两层结构。
- Composer 与视口左右边缘约有 20px 间距，底部留有可见空间。
- 上传、图片模式和提交操作保留为紧凑的触摸控件。

截图不能证明设备型号、浏览器 UI、standalone 模式或真实 `safe-area-inset-bottom` 数值。因此“底部安全区 Composer”在本轮只表示应保留底部避让空间，仍需真机和 standalone 证据确认。

## Limited Responsive Inference

桌面与手机截图的静态对照提供有限 `E2` 证据：

| Region | Desktop 1440x900 | Mobile 390x844 | Supported inference |
| --- | --- | --- | --- |
| Gallery | 居中的紧凑瀑布流，可见三列 | 近全宽双列 | 画廊会重排，手机不是桌面等比缩放 |
| Composer | 约 768px 居中，位于画廊上方 | 近全宽、贴近底部浮动 | Composer 的定位和宽度策略会随布局形态改变 |
| Parameter menus | 数量和比例菜单在控件上方打开 | 未捕获 | 只可实现桌面静态状态；手机载体仍为 `TBD` |

截图之间没有中间宽度证据，不能据此冻结断点、平板布局或连续尺寸公式。

## Explicitly Unverified

本轮证据不支持下列结论，相关规格继续保持 `Missing` 或 `TBD`：

- 登录后的导航 Rail、顶部控制区和完整 App Shell；
- 用户历史画廊、任务卡片、生成中/失败/拒绝状态；
- 视频 Composer、模型/Profile 菜单、参考图条和上传进度；
- Viewer、Saved、文件夹、设置和多选；
- 手机参数 Bottom Sheet、长按、滑动、系统返回和软键盘行为；
- PWA standalone、安全区数值、安装后窗口和离线状态；
- Hover、Focus、键盘、菜单关闭、动效和时序；
- 1920x1080、1280x800、平板、430x932 和 360x800 响应式行为；
- L3/L4 高保真结论或视觉回归通过结论。

公开页面中的登录、注册、站点标记和模板媒体不是本项目资产，不得复制。PR 1 只能把本文件中可观察的布局关系作为有限参考，并使用本项目自己的品牌、图标和 Mock 媒体。
