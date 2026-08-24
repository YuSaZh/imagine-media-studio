# Private Design Reference (Local Only)

本目录只用于本机保存冻结的 Grok Imagine 私有参考包。除本说明和 `.gitignore` 外，目录内容不得提交到 Git、上传到 CI artifact 或附加到 PR。

冻结目标：

```text
UI_REFERENCE_DATE=2026-08-24
UI_REFERENCE_TARGET=https://grok.com/imagine
```

## 本地目录结构

```text
.design-reference/
├── .gitignore
├── README.local.md
└── grok-imagine-2026-08-24/
    ├── desktop/
    ├── tablet/
    ├── mobile/
    ├── video/
    └── notes/
```

可按下列格式命名，便于在提交的规格中用 Reference ID 和相对路径定位：

```text
desktop/REF-DESKTOP-001__1440x900__gallery-empty.png
mobile/REF-MOBILE-001__390x844__composer-keyboard.png
video/REF-MOTION-001__composer-expand.mp4
notes/measurement-log.local.md
```

## 隐私和版权规则

- 禁止提交或分享登录态截图、录屏、Cookie、Token、用户名、头像、Prompt、生成历史或任何用户内容。
- 采集前使用专用无敏感数据的测试账号和可公开的占位内容；仍将全部采集物视作私有文件。
- 禁止将 Grok Logo、品牌专用素材、专有插画和原始图标文件复制到项目资产目录。
- 不要把私有参考文件改名后移出本目录来绕过忽略规则。
- 需要协作时只交流由参考证据推导出的文字规格、测量值和 Reference ID。

## 采集检查清单

1. 确认 URL 是 `https://grok.com/imagine`，记录采集日期但不记录认证信息。
2. 记录 CSS 视口、DPR、浏览器版本、缩放、主题、语言和系统类型。
3. 覆盖 `docs/design-spec/screen-matrix.md` 中的必采状态。
4. 对动效保留前后状态及录屏元数据；对移动端记录安全区与软键盘状态。
5. 在 `docs/design-spec/ui-reference-version.md` 登记 Reference ID 和相对路径。
6. 只把测量与结论写入 `docs/design-spec/`，不嵌入私有截图。

## 提交前检查

```bash
git status --short --ignored .design-reference
git check-ignore -v .design-reference/grok-imagine-2026-08-24/desktop/example.png
```

预期：私有参考包显示为 ignored，只有 `.gitignore` 与 `README.local.md` 可被跟踪。
