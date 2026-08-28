# Interaction Map

本文件是关键交互路径的验收依据。每条交互必须描述前置状态、输入、状态变化、反馈、退出方式和各输入模式，不能只描述点击后的最终页面。

## 状态命名

生成任务状态必须覆盖：

```text
queued -> submitting -> remote_pending -> remote_running
       -> downloading -> processing -> completed
```

终止状态：`failed`、`cancelled`、`rejected`。Provider 不提供真实进度时展示阶段，不显示虚假百分比。

## 交互记录模板

| Interaction ID | Surface/Region | 起始状态 | Trigger | Guard | 即时反馈 | 状态/焦点变化 | 完成状态 | 失败/取消 | Keyboard | Touch/Gesture | Reference ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `INT-TBD-001` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `E0` |

## PR 1 前必须规格化的路径

| Interaction ID | 路径 | 必须确认的节点 | Reference 状态 |
| --- | --- | --- | --- |
| `INT-COMPOSER-001` | Prompt 提交 | 空值禁用；提交反馈；乐观卡片；草稿清理策略 | Missing |
| `INT-COMPOSER-002` | 图片/视频模式切换 | 控件变化；不兼容参数处理；焦点保持 | Missing |
| `INT-COMPOSER-003` | Provider/Profile 切换 | Capability 收缩；提示；值保留/清除 | Missing |
| `INT-COMPOSER-004` | 粘贴图片 | 验证；缩略图；上传进度；失败移除 | Missing |
| `INT-COMPOSER-005` | 拖放图片 | Drop Overlay；验证；上传；离开恢复 | Missing |
| `INT-COMPOSER-006` | 快捷提交 | `Ctrl/Cmd+Enter`；禁用条件；重复提交保护 | Missing |
| `INT-OVERLAY-001` | 参数 Popover/Sheet | 打开；焦点；选择；确认/取消；Esc | Missing |
| `INT-GALLERY-001` | 新 Job 插入 | 稳定列宽；占位比例；阶段；取消 | Missing |
| `INT-GALLERY-002` | 无限加载 | 触发阈值；加载反馈；错误重试；位置保持 | Missing |
| `INT-GALLERY-003` | 过滤 | 过渡；空状态；滚动位置；结果数 | Missing |
| `INT-GALLERY-004` | 收藏/文件夹/删除 | 乐观反馈；撤销/确认；失败回滚 | Missing |
| `INT-GALLERY-005` | 多选 | 进入；范围选择；批量动作；退出 | Missing |
| `INT-JOB-001` | 失败重试 | 原 Prompt/参数；新旧 Job 关系；反馈 | Missing |
| `INT-JOB-002` | 取消 | 可取消阶段；确认；最终状态；失败恢复 | Missing |
| `INT-VIEWER-001` | 打开/关闭 Viewer | 来源卡片；过渡；历史；焦点恢复 | Missing |
| `INT-VIEWER-002` | 上一项/下一项 | 边界；预加载；键盘；手机滑动 | Missing |
| `INT-VIEWER-003` | 图片缩放/拖动 | 双击；滚轮/键盘 `TBD`；手势；复位 | Missing |
| `INT-VIEWER-004` | 媒体后续创作 | 作为参考；编辑；图片转视频；Capability | Missing |
| `INT-MOBILE-001` | Composer 与软键盘 | `visualViewport`；安全区；滚动/遮挡 | Missing |
| `INT-MOBILE-002` | 长按多选 | 长按阈值；触觉/视觉反馈；滚动冲突 | Missing |
| `INT-PWA-001` | PWA 更新 | 提示；接受/稍后；刷新；未保存草稿 | Missing |

## PR 7 实现验收记录

下表只记录项目实现和自动化行为证据，不提升缺少私有 Grok/真机参考的
`Reference 状态`，也不把这些交互标记为视觉 `Frozen`。

| Interaction ID | Automated evidence | Result | Remaining reference/device evidence |
| --- | --- | --- | --- |
| `INT-COMPOSER-001`, `INT-COMPOSER-006` | Prompt 草稿刷新/离线恢复、提交后清理、离线提交禁用、快捷键无写入 | Functional pass | Authenticated visual reference |
| `INT-OVERLAY-001` | Parameters Tab/Escape/focus return and mobile geometry | Functional/a11y pass | Authenticated motion/visual reference |
| `INT-GALLERY-002` | Independent cursor pagination, loading/error/retry/end, stable dedupe, bounded virtual rendering | Functional pass | Authenticated loading-state visual reference |
| `INT-GALLERY-004`, `INT-GALLERY-005` | Serialized optimistic actions, failure rollback, long-press/explicit selection, coarse-pointer menu | Functional pass | Authenticated visual and device touch evidence |
| `INT-VIEWER-001` through `INT-VIEWER-003` | Focus return, Escape, swipe, pinch, pan, double-tap, pointer cancellation, media filtering | Functional/a11y pass | Authenticated motion reference and real touch device |
| `INT-MOBILE-001`, `INT-MOBILE-002` | `visualViewport`/safe-area geometry and deterministic long press across approved viewports | Simulated geometry/functional pass | Real iOS/Android keyboard, safe area, and touch timing |
| `INT-PWA-001` | Durable notification preference, update apply/dismiss/retry, draft flush before reload | Functional pass | Real installed-app update on named operating systems |

## Overlay 行为模板

| Overlay | 打开方式 | 初始焦点 | Focus trap | 外部点击 | Esc/Back | URL/History | 关闭后焦点 | Mobile 载体 | Reference ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## 任务状态反馈模板

| Job state | 卡片视觉 | 可用动作 | 文案规则 | 真实进度 | 离开/刷新后行为 | Reference ID |
| --- | --- | --- | --- | --- | --- | --- |
| `queued` | `TBD` | `TBD` | `TBD` | N/A | 恢复 | `TBD` |
| `submitting` | `TBD` | `TBD` | `TBD` | `TBD` | 恢复/归一化 `TBD` | `TBD` |
| `remote_pending` | `TBD` | `TBD` | `TBD` | Provider-dependent | 恢复 | `TBD` |
| `remote_running` | `TBD` | `TBD` | `TBD` | Provider-dependent | 恢复 | `TBD` |
| `downloading` | `TBD` | `TBD` | `TBD` | `TBD` | 恢复 | `TBD` |
| `processing` | `TBD` | `TBD` | `TBD` | `TBD` | 恢复 | `TBD` |
| `completed` | `TBD` | `TBD` | `TBD` | Complete | 持久化 | `TBD` |
| `failed` | `TBD` | Retry, details `TBD` | 保留 Prompt | N/A | 持久化 | `TBD` |
| `cancelled` | `TBD` | Retry/delete `TBD` | `TBD` | N/A | 持久化 | `TBD` |
| `rejected` | `TBD` | Details/edit prompt `TBD` | 与 failed 区分 | N/A | 持久化 | `TBD` |

## 验收规则

- 所有关键路径必须与本文件一致后才可通过 UI Gate。
- 桌面必须验证鼠标和键盘，移动端必须验证触摸、手势、系统返回与软键盘。
- Popover、Sheet、Viewer 和菜单必须记录焦点进入、焦点约束及焦点恢复。
- 未被证据确认的交互不得标为 `Frozen`。
