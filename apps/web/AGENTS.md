# Frontend Agent Guide

Read the [root guide](../../AGENTS.md) and
[workspace specification](../../docs/design-spec/workspace.md).

## UI Ownership

- `src/features/workspace/` owns the production UI. Extend its existing React,
  Radix, Lucide, routing, and CSS patterns; do not reintroduce retired page shells.
- Desktop and mobile have separate layout and interaction requirements, with
  shared business state, capabilities, and API contracts. Keep the layout
  decision in `workspace-layout.ts` consistent with the CSS breakpoint.
- Scope desktop-only rules to `workspace-desktop.css` and the desktop branch.
  Preserve mobile touch targets, safe areas, keyboard handling, and compact tools.
- The desktop gallery scrolls inside its own container. Keep virtualization and
  pagination observers bound to that same container, with header controls fixed.
- Preserve stable Composer geometry across image/video modes. Use the current
  specification for shortcut placement and active/inactive mode labels.
- Use semantic controls, accessible names for icon buttons, keyboard focus
  management, and visible error/loading/disabled states. Do not hide errors or
  add simulated success, fake production media, or unsupported controls.

## State and API Boundaries

- TanStack Query owns server state through `src/api/` and workspace query helpers.
  SSE events invalidate/refetch authoritative data; avoid a second global copy
  of the gallery, jobs, Providers, or account data.
- Remember image/video models independently. Generation choices are scoped by
  account, project, media type, and Provider/model identity; preserve hydration
  before writing defaults. Account administration stays separate from preferences.
- Build controls from model capabilities and parameter policies. Aspect ratios
  are choices; custom numeric dimensions belong in their own validated controls.
- Browser code calls internal APIs, never Provider endpoints with credentials.
  Shared schemas belong in `packages/shared`; wire adapters belong on the server.
- PWA storage excludes credentials, authorization headers, generation writes,
  and full videos. Offline previews/drafts stay bounded and account-scoped;
  offline mode must not submit generation or take ownership of server jobs.

## Verification

Use the [root matrix](../../CONTRIBUTING.md#verification). For layout changes,
inspect desktop and mobile behavior, including the unaffected layout. Cover
mode switching, long labels, popovers, keyboard/focus, scrolling, and pagination
when affected. Shared layout changes need the full configured viewport matrix.
Read [e2e rules](../../e2e/AGENTS.md) before changing browser tests or baselines.
Keep the production entry budget enforced by `scripts/check-build-budget.mjs`.
