# Visual Diff Report - PR 7

- Reference version: `2026-08-24`
- Mock fixture: `pr1-v1`
- Browser/font environment: Playwright 1.62.1 Chromium on `ubuntu-24.04`, system UI font stack, DPR 1
- Automated acceptance: see `docs/architecture/pr7-verification.md`

## Reference states

Grok Imagine remains the only UI/UX reference. The available public evidence
supports the broad white canvas, compact Gallery, mobile two-column layout, and
bottom Composer relationships. The private authenticated reference package is
unavailable, so authenticated Gallery, Viewer, settings, task, standalone, and
keyboard states have no reference ID and strict L3/L4 comparison is deferred.

## Implementation evidence

Screenshots use the fixed PR1 Mock fixture with animations disabled. CI also
runs production cold-offline and unknown-marker checks at every PR7 viewport.

| Viewport | State | Actual | Reference baseline | Masks | Result |
| --- | --- | --- | --- | --- | --- |
| desktop-1920x1080 | Gallery | `desktop-1920x1080.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |
| desktop-1440x900 | Gallery | `desktop-1440x900.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |
| desktop-1280x800 | Gallery | `desktop-1280x800.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |
| tablet-1024x1366 | Gallery | `tablet-1024x1366.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |
| tablet-1024x1366 | Menu / selection | `tablet-1024x1366-gallery-menu.png`, `tablet-1024x1366-gallery-selection.png` | Unavailable (Hold) | Dynamic media | Interaction geometry pass |
| tablet-834x1194 | Gallery | `tablet-834x1194.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |
| tablet-834x1194 | Menu / selection | `tablet-834x1194-gallery-menu.png`, `tablet-834x1194-gallery-selection.png` | Unavailable (Hold) | Dynamic media | Interaction geometry pass |
| mobile-430x932 | Gallery / selection | `mobile-430x932.png`, `mobile-430x932-gallery-selection.png` | Unavailable (Hold) | Dynamic media | Functional/interaction geometry pass |
| mobile-430x932 | Image / video Viewer | `pr7-mobile-430x932-image-viewer.png`, `pr7-mobile-430x932-video-viewer.png` | Unavailable (Hold) | Dynamic media / video time | Interaction geometry pass |
| mobile-430x932 | Keyboard / safe area | `mobile-430x932-keyboard-mock.png` | Real device unavailable (Hold) | OS keyboard not rendered | Deterministic geometry pass |
| mobile-390x844 | Gallery / selection | `mobile-390x844.png`, `mobile-390x844-gallery-selection.png` | Unavailable (Hold) | Dynamic media | Functional/interaction geometry pass |
| mobile-390x844 | Image / video Viewer | `pr7-mobile-390x844-image-viewer.png`, `pr7-mobile-390x844-video-viewer.png` | Unavailable (Hold) | Dynamic media / video time | Interaction geometry pass |
| mobile-390x844 | Keyboard / safe area | `mobile-390x844-keyboard-mock.png` | Real device unavailable (Hold) | OS keyboard not rendered | Deterministic geometry pass |
| mobile-360x800 | Gallery | `mobile-360x800.png` | Unavailable (Hold) | Dynamic media | Functional geometry pass |

No pixel comparison is claimed because the authenticated baseline is
unavailable. Dynamic-media masks are recorded for future reference comparison;
no Shell, Composer, control, or status region is masked.

## Known differences

| Difference | Intentional | Follow-up |
| --- | --- | --- |
| No authenticated Grok pixel baseline or <=2% stable-region claim | No; evidence unavailable | Review the private reference package recorded in `Hold.md` |
| Keyboard screenshots inject `visualViewport` and CSS safe-area values | Yes; deterministic CI geometry fixture | Capture real iOS/Android keyboard and safe-area evidence |
| Settings/PWA surfaces have no Grok counterpart | Yes; project extension | Retain the frozen product tokens and accessibility gates |

## Interaction verification

| Interaction | Desktop/tablet | Mobile | Result |
| --- | --- | --- | --- |
| Offline completed Gallery recovery / online active Job reopen | Offline recovery + representative active reopen | Offline recovery; active reopen represented on desktop | Pass |
| Gallery selection and card menu | Keyboard/pointer/coarse pointer | Long press and explicit selection | Pass |
| Image/video Viewer | Keyboard/Escape | Swipe, pinch, pan, double-tap | Pass |
| Keyboard/safe-area Composer geometry | N/A | Deterministic mock | Pass with external device evidence pending |

The implementation and geometry gates pass. Strict reference pixel comparison
and real-device validation are intentionally not claimed.
