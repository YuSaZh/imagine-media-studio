# PR 8 Project Visual Baseline

Status: **Local and GitHub Actions pixel comparison passed.**

This is a repository-owned implementation baseline for the stable Imagine
workspace. It uses the explicit PR 1 Mock fixture and does not represent the
private authenticated Grok Imagine reference, a Grok pixel-parity result, or
an installed Windows, macOS, Android, or iOS device.

## Frozen environment

| Item | Value |
| --- | --- |
| Mock data | `pr1-v1` via `imagine.visual-fixtures` session marker |
| Browser | Playwright 1.62.1 bundled Chromium; Chrome for Testing 151.0.7922.34 locally |
| Viewport and DPR | CSS pixel viewports below; device scale factor `1` |
| Locale and timezone | `en-US` / `UTC` |
| Color scheme and motion | `light` / `prefers-reduced-motion: reduce` |
| UI fonts | `Liberation Sans`; mono controls use `Liberation Mono` |
| Screenshot scale | CSS pixels |

The test waits for `document.fonts.ready`, visible fixture images to decode,
the gallery to settle, and the PWA notice to be dismissed. The fixed fixture
contains fixed media and timestamps, so no screenshot mask is needed. The
matcher still declares `mask: []` explicitly; no Shell, Composer, control,
status, or media region is hidden.

## Baseline files

| Project | Viewport | Snapshot | SHA-256 | Result |
| --- | --- | --- | --- | --- |
| `pr8-visual-desktop-1440x900` | 1440 x 900 | [`workspace.png`](../../e2e/visual-baselines/pr8/pr8-visual-desktop-1440x900/workspace.png) | `1c47e966e959c94c259f4b459420c165b89bf300ca2fe76c9e29b4be5d3c91b8` | Pass |
| `pr8-visual-desktop-1920x1080` | 1920 x 1080 | [`workspace.png`](../../e2e/visual-baselines/pr8/pr8-visual-desktop-1920x1080/workspace.png) | `d5f82857475d0c04a442e265dbb78205d54884e31185e42185e5e239810c4245` | Pass |
| `pr8-visual-mobile-390x844` | 390 x 844 | [`workspace.png`](../../e2e/visual-baselines/pr8/pr8-visual-mobile-390x844/workspace.png) | `df07214e593274fd6f392088c437218cbba5f6d19e36025932c6b5b8d97a674f` | Pass |
| `pr8-visual-mobile-430x932` | 430 x 932 | [`workspace.png`](../../e2e/visual-baselines/pr8/pr8-visual-mobile-430x932/workspace.png) | `25ddbe4d4268b80212b6d6446c1adcbd0a3e9578a340e9715a595219bb73de97` | Pass |

## Gate

[`e2e/pr8-visual.spec.ts`](../../e2e/pr8-visual.spec.ts) runs once in each
project and uses Playwright `expect(page).toHaveScreenshot('workspace.png')`.
The configured snapshot path is
`e2e/visual-baselines/pr8/<project>/workspace.png`.

- The screenshot comparison uses `threshold: 0.2` and
  `maxDiffPixelRatio: 0.02`, matching the visual policy's stable-core ceiling.
- `animations: 'disabled'`, hidden caret, reduced motion, and fixed CSS font
  variables keep the capture state deterministic.
- The test checks PNG signature, exact viewport dimensions, non-empty bytes,
  decoded visible media, fixed-region geometry, and pairwise gallery-card
  non-overlap before the pixel matcher runs.
- The four required Plan viewports are the only release baseline scope in this
  milestone; additional PR7 interaction captures remain separate evidence.

## Local verification

Using a task-owned E2E data directory and non-conflicting port with the
Playwright bundled browser:

| Check | Result |
| --- | --- |
| E2E TypeScript compilation for config and visual spec | Pass |
| Targeted ESLint | Pass |
| Web production build | Pass |
| Baseline generation with `--update-snapshots=all` | 4/4 passed |
| Baseline comparison with `--update-snapshots=none` | 4/4 passed |
| `git diff --check` | Pass |

The local generation and comparison used `E2E_PORT=4317` and omitted
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, so both runs used the installed
Playwright bundled browser. CI makes the comparison-only behavior explicit
with `--update-snapshots=none`.

## Remote verification

Commit `4dc4432` passed all four independent PR 8 visual jobs in
[GitHub Actions run 33216883872](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33216883872):
`pr8-visual-desktop-1440x900`, `pr8-visual-desktop-1920x1080`,
`pr8-visual-mobile-390x844`, and `pr8-visual-mobile-430x932`. Each job performed
comparison-only `toHaveScreenshot` acceptance against the committed PNG for its
project and uploaded the baseline/report artifact. The same run's quality,
single-container, base E2E, PR 7 viewport, and accessibility/performance jobs
also passed.

## CI boundary

The independent `pr8-visual` matrix in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the same four
projects on `ubuntu-24.04` with `contents: read`, an isolated temporary data
directory, a production build, bundled Chromium, and `toHaveScreenshot`. It
uploads the project snapshot plus Playwright report and failure diff artifacts,
then removes only its validated temporary directory.

This gate proves repeatable project-owned rendering and geometry. It does not
prove strict L3/L4 similarity to Grok Imagine, real PWA installation,
standalone relaunch, OS keyboard behavior, or device safe-area values. Those
remain explicitly open in [`Hold.md`](../../Hold.md).
