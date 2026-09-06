# Browser Test Agent Guide

Read the [root guide](../AGENTS.md), [frontend guide](../apps/web/AGENTS.md), and
[playwright.config.ts](../playwright.config.ts) before changing browser coverage.

- Tests exercise the real authenticated local server and internal APIs with the
  deterministic Mock Provider. Upload test media through fixtures; do not seed
  fake production galleries or use a running user's deployment.
- Build first. Local execution requires an explicit unused `E2E_PORT`.
  `runtime.ts` creates task-owned temporary data; setup/teardown own its lifecycle.
  Do not override the data directory with existing data or enable server reuse.
- Keep one worker per server. Concurrent runs need distinct ports, data roots,
  and output directories. Avoid importing runtime helpers just to inspect config:
  importing them can create a temporary directory.
- Use `--update-snapshots=none` for verification. Update only intentionally changed
  baseline images after inspecting the before/after rendering and explaining the
  UI change. Do not regenerate baselines merely to make a failure disappear.
- Select representative desktop and mobile projects for a focused UI change;
  shared layout, navigation, PWA, or geometry changes need all configured projects.
  Include narrow screens, long labels, mode switching, popovers, and scroll behavior
  when affected. Keep accessible-name and keyboard/focus checks meaningful.
- Normal workflow tests block Service Workers; PWA tests deliberately enable them.
  Do not remove offline/cache/auth assertions to reduce test flakiness.
- Prefer visible state and response assertions over arbitrary sleeps. Retain
  failure traces/screenshots without credentials or private provider payloads.
- Clean task-owned runtime data/processes after runs, including interrupted runs.
  Keep baseline media and licensing provenance in the workspace specification.
- Report fixture/browser coverage separately from live Provider and physical
  device installation evidence; see [Hold.md](../Hold.md) for recorded limits.

Commands and gate selection: [CONTRIBUTING.md](../CONTRIBUTING.md#verification).
