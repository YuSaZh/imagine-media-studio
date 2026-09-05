# Imagine workspace

The production UI in `apps/web/src/features/workspace/` replaces the previous page components, page store, styles, visual fixtures and separate interaction prototype. All routes use one authenticated application and real internal APIs. Existing `/interaction.html` bookmarks redirect to `/imagine`.

## Interaction

- `/imagine`: bottom Composer on desktop and phones, with a virtual masonry gallery above. Models, input modes, aspect ratios and parameters follow enabled Provider capabilities; compatible image models also expose custom pixel dimensions and declared extra fields such as quality and output format.
- `/library`, `/saved`, `/projects/:id`: server-filtered assets, filename/prompt/model search, pagination, selection, favorites, project membership and confirmed deletion.
- `?asset=:id`: original image or native video, original MIME download, zoom/gestures, request information and continued creation.
- `/edit/:id`: responsive original-image mask canvas, brush/eraser, undo/redo and persisted source/mask inputs.
- `/jobs`: durable status, results, cancellation and retry; also available from the header.
- `/settings`: persisted preferences, Provider/model management, custom HTTP/trusted JavaScript adapters, database/media maintenance and PWA controls.

Grok Imagine is the sole visual reference. Its public DOM, computed styles and creation controls were inspected directly during the redesign. No Grok page source, logo or styles were copied. Existing nonvisual upload validation, mask rasterization, gestures, session/cache and adapter-security code remains in use.

## Data behavior

Generation calls the real Job API. No browser timer or seeded production gallery simulates output. Mock remains a server test Provider; real generation requires an external Provider.

Unlabelled OpenAI-compatible and xAI image results use an unknown binary MIME hint until the existing media signature detector identifies the actual format. They are not assumed to be PNG. Explicit upstream MIME declarations remain subject to mismatch rejection. Output format is omitted unless selected by the user.

Compatible Images catalogs offer custom dimensions without inheriting GPT-only fixed-size restrictions. Model capability overrides can be saved from discovered models as manual definitions. The Composer exposes declared scalar extra parameters and omits aspect ratio when explicit dimensions take precedence.

Each Asset page contains at most 60 records and associated jobs. Search and project/favorite filters run on the server. There is no 1,000-result browsing cutoff or eager full-asset inventory request. Model selection distinguishes identical external model IDs belonging to different Providers. The Viewer uses original content URLs.

Write failures remain visible. Deletion requires confirmation and has no fictitious undo. Offline mode retains authenticated recent previews and prompt drafts and disables writes. API keys stay in the server's encrypted store; configuration exports exclude keys and custom headers.

## Verification

`e2e/workspace.spec.ts` exercises a real password-protected server across 1920, 1440, 1280, 1024, 834, 430, 390 and 360 pixel viewports. Baselines in `e2e/visual-baselines/workspace/` are project regression references, not a claim of Grok pixel parity. Tests cover generation, video, originals, favorites, failures, projects/search, masks, connections, persistence and WCAG 2 A/AA.

Run `pnpm run ci`, then `E2E_PORT=<unused-task-port> pnpm test:e2e --update-snapshots=none`. The single-container Docker API/archive/security smoke remains a separate gate. Default builds always ship this workspace.

Local replacement acceptance: 108 unit-test files / 996 tests, lint, TypeScript, production bundle budget, 56 browser tests across eight viewports, and the complete isolated Docker upgrade/archive/media/adapter/persistence smoke passed. Normal workflow tests block Service Workers so intercepted responses remain deterministic; a separate PWA suite enables and verifies the real offline cache on every viewport.

## Test media

Previously reviewed Unsplash photos now live only in `e2e/media/`; tests upload them through the Asset API. They are not production gallery content. PWA installation screenshots show this test session.

| File | Source |
| --- | --- |
| coast.webp | https://images.unsplash.com/photo-1518837695005-2083093ee35b |
| mountain.webp | https://images.unsplash.com/photo-1506905925346-21bda4d32df4 |
| botanical.webp | https://images.unsplash.com/photo-1497250681960-ef046c08a56e |
| architecture.webp | https://images.unsplash.com/photo-1486406146926-c627a92ad1ab |

Icons use existing Lucide; dialogs/popovers/tooltips use existing Radix. No dependency was added or upgraded.
