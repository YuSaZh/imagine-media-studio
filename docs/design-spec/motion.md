# Motion

动效必须基于冻结参考录屏或前后状态证据。PR 0 只定义待测范围和记录方法，不预设最终时长或 easing。

## 测量方法

1. 优先使用稳定帧率录屏，记录录制帧率和播放速率。
2. 标记触发帧、首次视觉变化帧、主体运动结束帧和完全稳定帧。
3. 分别记录 enter、exit、interrupt 和 reverse 行为。
4. 无法准确测量时给出范围并标记置信度，不伪造精确毫秒值。
5. 动态媒体播放不作为 UI 动效测量来源。

## 动效清单

| Motion ID | Surface | Trigger | From -> To | Duration | Delay | Easing | Properties | Interrupt/reverse | Reference ID | Evidence | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MOTION-001` | Composer | 展开/收起 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-002` | Popover | 打开/关闭 | hidden -> visible | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-003` | Bottom Sheet | 打开/关闭 | offscreen -> open | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-004` | Gallery card | hover/focus | rest -> emphasis | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-005` | Viewer | 打开/关闭 | card -> overlay `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-006` | Job card | 阶段变化 | state A -> state B | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-007` | Gallery | 新卡片插入 | absent -> placed | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-008` | Gallery | 过滤 | set A -> set B | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-009` | Toast | 出现/退出 | hidden -> visible | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |
| `MOTION-010` | PWA update | 提示 | hidden -> visible | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` | Draft |

## 生成状态动效

| Job state | 视觉反馈 | Loop | Frequency/duration | 真实进度条件 | Reduced motion | Reference ID |
| --- | --- | --- | --- | --- | --- | --- |
| `queued` | `TBD` | `TBD` | `TBD` | N/A | `TBD` | `TBD` |
| `submitting` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| `remote_pending` | `TBD` | `TBD` | `TBD` | Provider-dependent | `TBD` | `TBD` |
| `remote_running` | `TBD` | `TBD` | `TBD` | Provider-dependent | `TBD` | `TBD` |
| `downloading` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| `processing` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## Reduced Motion

实现必须支持：

```css
@media (prefers-reduced-motion: reduce) {
  /* 具体规则由本表冻结后实现 */
}
```

| Motion ID | 标准行为 | Reduced 行为 | 信息是否保留 | 焦点/滚动影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `MOTION-TBD` | `TBD` | 无位移/瞬时/淡化 `TBD` | 必须 Yes | `TBD` | Draft |

Reduced Motion 不得隐藏状态变化或完成反馈，只减少非必要位移、缩放和循环运动。

## 性能与验收

- 优先测量并实现 `transform`/`opacity` 类动效；使用其他属性必须说明原因。
- 动效不得改变稳定几何尺寸或导致画廊大面积布局跳动。
- 键盘和触摸触发必须得到同等反馈。
- 截图视觉回归在稳定帧执行；动效行为使用独立交互或视频证据验收。
