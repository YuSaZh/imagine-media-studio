# Release Notes Rules

Read this file whenever preparing or publishing a release. It governs the release description; [RELEASE.md](../RELEASE.md) governs the release procedure, image verification, upgrades, and recovery.

## Reference and Audience

Use the organization of the [LobeHub v2.2.16 release notes](https://github.com/lobehub/lobehub/releases/tag/v2.2.16): an overview, highlights, changes grouped by product area, contributors, and a full changelog link. Adapt the structure to this repository's actual changes; do not copy upstream text, statistics, features, screenshots, or branding.

Write for self-hosting users and maintainers. Use Chinese by default, retaining exact protocol names, configuration keys, and commands. Describe the trigger, changed behavior, and user impact in concrete terms. Avoid marketing claims, an unfiltered commit dump, and empty sections.

## Source of Truth

- Review commits and merged PRs since the previous stable tag, plus the reviewed changes being prepared for release. Do not infer release content from a plan.
- Put the authored description in exactly one non-empty `CHANGELOG.md` section headed `## [X.Y.Z] - YYYY-MM-DD`. Use `###` and deeper headings inside it: the release generator treats the next `##` heading as the section boundary.
- The workflow extracts that section and appends the verified container digest and version-pinned release guide. Do not edit the published body separately, duplicate the container block, or invent a digest before the smoke gate.
- Link notable groups of changes to real PRs or commits. When there are no PRs, use commit links and the tag comparison. Never fabricate PR counts, authors, performance improvements, completed tests, or live Provider acceptance.
- Exclude local Agent overrides, hostnames, SSH aliases, private addresses, credentials, private prompts, and deployment logs from public notes.

## Line Wrapping

- Keep each prose paragraph, blockquote summary, and list item on one physical Markdown source line, including its related PR or commit links. Let GitHub wrap text to the reader's viewport width.
- Do not wrap prose to a fixed character count or insert manual line breaks for visual alignment. Do not add `<br>`, trailing double spaces, or backslashes to force prose wrapping.
- Keep structural newlines between headings, paragraphs, and separate list items. Preserve meaningful line breaks inside code blocks and tables.
- When joining previously wrapped Chinese text, do not introduce spaces between adjacent Chinese words or punctuation; retain normal spaces around English terms, numbers, and links.

## Description Structure

1. **Release context:** date and previous stable version. Include commit, PR, or contributor counts only when verified against that comparison range.
2. **Overview:** a short paragraph or blockquote describing the main outcomes.
3. **Highlights:** three to five important changes for normal releases; use fewer for a small patch. State user-visible results, with supporting links.
4. **Changes by area:** use relevant sections such as image/video generation, model management, desktop/mobile experience, and reliability. Consolidate related fixes and avoid repeating the full highlights verbatim.
5. **Upgrade notes and limits:** call out breaking changes, migrations, changed defaults, compatibility constraints, or required operator actions. Preserve the distinction between fixture coverage and live upstream support.
6. **Contributors:** credit actual authors, using verified GitHub handles when available; omit unsupported attribution or statistics.
7. **Full changelog:** link `previous-tag...new-tag` in this repository.

Example outline (remove unused sections and all placeholders before publishing):

```markdown
## [X.Y.Z] - YYYY-MM-DD

发布日期：YYYY-MM-DD · 上一稳定版：vA.B.C

> 用一段话概括本次版本解决的问题和用户可以感受到的变化。

### 重点更新

- **具体变化：** 描述结果与影响。([commit](https://github.com/OWNER/REPO/commit/SHA))

### 生图与模型管理

- 按主题归并的功能改进与修复。

### 桌面与移动端

- 双端界面和交互的实际变化。

### 升级说明与限制

- 已核实的升级要求、兼容性变化和限制。

### 贡献者

- [@author](https://github.com/author)

完整变更：[vA.B.C...vX.Y.Z](https://github.com/OWNER/REPO/compare/vA.B.C...vX.Y.Z)
```

## Before Publishing

Check all release-facing versions, render the generated notes locally with a fixture digest, and run `pnpm test:release`. Confirm that all authored sections survive extraction, historical sections are excluded, every public link is correct, and prose has no manual wrapping. Before pushing the release commit or tag, require complete local CI on the final prepared source: quality checks, all tests, production build, the entire eight-viewport browser suite, and the same isolated Docker smoke as GitHub CI. Then push the verified release commit to GitHub `main` and the matching tag. The tag workflow automatically runs quality and eight-viewport browser checks, so there is no separate wait for remote branch CI before tagging. It then builds one multi-platform candidate, attests it, tests its digest, and promotes that same image before creating the GitHub Release. Let those gates complete before announcing the release. Verify the final published body and immutable image digest afterward.
