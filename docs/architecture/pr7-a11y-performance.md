# PR 7 Accessibility and Performance Gates

This document records the automated PR 7 acceptance boundary for the production
web build and the deterministic PR 1 visual fixture.

## Accessibility

`e2e/pr7-a11y-perf.spec.ts` uses `@axe-core/playwright` with the WCAG 2A and
2AA rule sets. Every report is attached to the Playwright result and printed as
JSON so that a failure keeps the affected rule, impact, help text, and node
count visible in CI.

The gate blocks `critical` and `serious` violations. Lower-impact findings are
reported for follow-up but do not make this phase flaky while the visual system
is still being tuned.

No axe rules are disabled. Contrast is evaluated by the same WCAG scan as
names, semantics, landmarks, keyboard behavior, and focus behavior. A future
technical-only exclusion must identify one concrete node, include reproducible
evidence, and be recorded here before it is added.

The scan states are:

| Surface | Production | Fixture |
| --- | --- | --- |
| `/imagine` gallery | Yes | Yes |
| Generation parameters | Yes | Yes |
| Viewer | Yes | Yes |
| Mobile navigation | Representative mobile project | Representative mobile project |
| `/settings/pwa` online and offline | Yes | Yes |
| Update notice | Deterministic notice fixture with production styling | Deterministic notice fixture with production styling |

The production Imagine run first creates one uniquely named completed Mock
image through the authenticated internal API, waits for its asset, and deletes
the job and assets in a `finally` block. This keeps the production Viewer scan
independent of an empty database without leaving test media behind. The
general empty-gallery check accepts either the `Media gallery` landmark or the
explicit `.gallery-empty` state.

The update notice is mounted as a deterministic DOM fixture because creating a
new Service Worker version during a production-build browser run would make the
check depend on timing and cache state. The actual Service Worker update
lifecycle remains covered by the PWA unit tests and the existing PR 7 browser
flows. The fixture mirrors the production component structure and uses the
production stylesheet; it is not an axe-rule exclusion.

Keyboard acceptance verifies that Tab remains inside the Viewer dialog, Escape
closes both the parameters Popover and Viewer, and focus returns to the control
that opened each surface. The reduced-motion acceptance emulates
`prefers-reduced-motion: reduce`, verifies transitions and animations are
disabled, and verifies status feedback remains present.

## Performance

The performance gate uses browser `PerformanceResourceTiming` and buffered
`layout-shift` entries. It intentionally does not report synthetic LCP or INP:
those metrics require representative device and field conditions that a single
headless Chromium runner cannot provide.

The same hard budgets run against the production and visual-fixture `/imagine`
first screen:

| Metric | Budget | Measurement |
| --- | ---: | --- |
| Vite entry JavaScript raw bytes | `<= 500,000` bytes | Largest of decoded, encoded, and transferred bytes for `/assets/index-*.js` |
| First-screen JavaScript requests | `<= 8` | Same-origin `/assets/*.js` resource entries after the initial route settles |
| First-screen JavaScript raw bytes | `<= 950,000` bytes | Sum of the resource byte values above |
| Cumulative Layout Shift | `<= 0.10` | Sum of buffered layout-shift values excluding recent-input shifts |

Each snapshot is attached to the Playwright result with the budget and every
matched JavaScript resource. A missing entry resource is a failure rather than
an inferred value.

## CI Scope

The regular PR 7 matrix runs geometry and interaction coverage at every
approved viewport. Its command excludes tests tagged `[PR7 a11y]` and
`[PR7 perf]`. A second two-project matrix runs those heavier gates only at
`pr7-desktop-1440x900` and `pr7-mobile-390x844`.

This keeps responsive geometry coverage broad while making automated a11y and
resource budgets deterministic and bounded to the representative desktop and
mobile environments.

GitHub Actions [run 33174754136](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136)
passed all 13 jobs for commit `a58ab7b`. The representative desktop
[axe/performance job 98860362200](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362200)
and mobile [job 98860362147](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362147)
both passed without adding a rule exclusion.

## Evidence Boundary

The static E2E TypeScript check, representative project listing, unit suite,
production build, and diff check pass in this checkout. A local browser run was
attempted on isolated ports and data directories, but the primary execution
sandbox rejects the server's required `0.0.0.0` listener with `listen EPERM`.
An isolated reviewer run completed the production and fixture performance cases
at the representative desktop and mobile viewports (`4/4` passed); no local axe
pass is claimed. The representative CI jobs remain the required runtime evidence
for the complete axe and Performance API assertions.
