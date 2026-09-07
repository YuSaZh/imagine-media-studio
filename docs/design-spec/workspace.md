# Imagine workspace

The production UI in `apps/web/src/features/workspace/` replaces the previous page components, page store, styles, visual fixtures and separate interaction prototype. All routes use one authenticated application and real internal APIs. Existing `/interaction.html` bookmarks redirect to `/imagine`.

This is the current UI specification. Contributor workflow and scoped rules live
in [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[apps/web/AGENTS.md](../../apps/web/AGENTS.md).

## Interaction

- `/imagine`: bottom Composer on desktop and phones, with a virtual masonry gallery above. Models, input modes, aspect ratios and parameters follow enabled Provider capabilities; compatible image models also expose custom pixel dimensions and declared extra fields such as quality and output format.
- `/library`, `/saved`, `/projects/:id`: server-filtered assets, filename/prompt/model search, pagination, selection, favorites, project membership and confirmed deletion.
- `?asset=:id`: original image or native video, original MIME download, zoom/gestures, request information and continued creation.
- `/edit/:id`: responsive original-image mask canvas, brush/eraser, undo/redo and persisted source/mask inputs.
- `/jobs`: durable status, results, cancellation and retry; also available from the header.
- `/settings`: persisted preferences, Provider/model management, custom HTTP/trusted JavaScript adapters, database/media maintenance and PWA controls.

Grok Imagine is the sole visual reference. Its public DOM, computed styles and creation controls were inspected directly during the redesign. No Grok page source, logo or styles were copied. Existing nonvisual upload validation, mask rasterization, gestures, session/cache and adapter-security code remains in use.

## Desktop and mobile layouts

Desktop and mobile are distinct UI layouts sharing generation state, internal API
contracts, and model policy. `workspace-layout.ts` selects desktop at 761px and
above; CSS and layout branching must use the same boundary. Platform-specific
changes must preserve the other layout's behavior.

- Desktop keeps the header, gallery heading/search/filter controls, and Composer
  outside the masonry scroll area. Virtualization and pagination use the inner
  `.gallery-scroll` element rather than the page scroll position.
  Its scrollbar tracks are hidden; wheel, touchpad and pagination remain active.
  Desktop generation settings also scroll without visible scrollbar tracks.
- Desktop video input modes occupy a separate row beneath the prompt, aligned
  above the add-reference button. The main toolbar retains a stable add-button
  position across image/video modes and supported/unsupported upload states.
- Desktop image/video switching shows an icon and label for the selected mode,
  and only an icon for the inactive mode. Mobile shows icons for both modes.
- Desktop retains the aspect-ratio shortcut. Its `auto` option has a dashed-square
  marker. Mobile image mode exposes aspect ratio in its shortcut row and in
  generation settings. Mobile video keeps aspect ratio in generation settings;
  video input modes remain in the compact control area.
- Model and aspect-ratio shortcut buttons have no downward chevrons on either layout.
  All former native selects use shared rounded Radix popovers, including generation
  settings, model/connection administration, preferences, adapter formats and job
  filters. Lists expose selected/disabled states, wrap long options, scroll within
  viewport bounds, and support arrows, Home/End, typeahead, Enter and Escape.
  Both layouts use a ratio grid whose column count follows the available options,
  balanced across rows with up to six columns (eight options use two rows of four).
- Desktop image shortcuts place resolution directly after aspect ratio, followed
  by an icon and count. Resolution offers auto, 1K, 2K, 4K and custom pixel dimensions;
  native size names take priority when supported by the model protocol and policy.
  Pixel-only models map presets by aspect ratio. For 16:9, presets
  map to 1280x720, 2048x1152, and 3840x2160; portrait swaps the dimensions.
  Other ratios use 1024, 2048, and 4096 as the longest edge. Chat adapters map
  recognized pixel sizes to upstream aspect-ratio/size fields and reject
  unrepresentable custom sizes; Images adapters retain pixel sizes. Actual
  output dimensions remain subject to the upstream model. Model rules, locks and
  custom-size limits apply; shortcuts share the saved generation settings.
- Mobile image generation settings offer exactly `auto`, `1K`, `2K`, `4K`, and
  custom dimensions, using the same preset mapping as desktop. This applies to
  both capability-based and managed parameter controls. Unsupported presets and
  locked settings remain disabled. Changing aspect ratio retains the selected
  preset and recalculates pixel dimensions; custom width/height inputs validate
  before applying and remembered settings remain scoped to the current model.
- Mobile image mode additionally exposes aspect ratio, resolution and count as
  compact icon/value buttons alongside the image/video switch in the main
  toolbar, using the desktop button appearance without filled tiles or a
  separate row. Their popovers share the same state as generation settings;
  resolution includes auto and custom dimensions. Each button has a 40px touch
  height, resolution/ratio model locks still apply, and the row is absent in video mode.
- Generation count is an application task count (1-32), independent of model
  batch capabilities and count parameter rules, including legacy locked/hidden
  rules. Both layouts and generation settings share a compact 1/2/4/8/+ popover;
  plus opens a validated custom count input. Each job requests one output and
  server queue limits bound actual execution concurrency. Count is remembered
  per project, media type and model alongside the other generation choices.
- Custom image dimensions use one editor in shortcuts and generation settings.
  The central lock starts enabled; changing either edge derives the other from
  the selected aspect ratio. Unlocking immediately switches the aspect ratio to
  auto without clearing the draft or changing the saved resolution. This applies
  to shortcuts and generation settings on both layouts. A model-fixed non-auto
  ratio cannot be unlocked. Auto never couples the edges. The edited edge snaps
  to the nearest multiple of 16 on blur/apply (ties round upward, minimum 16);
  the derived edge is also rounded, so the ratio may differ by rounding error.
  Both edges remain at most 16384, with at most 100 million pixels total.
  Applying custom dimensions preserves the selected aspect ratio rather than
  replacing it with a reduced width/height fraction. Native preset wire values
  and model-specific custom-size restrictions remain in effect.
- Desktop video shortcuts offer resolution presets 480p, 720p, 1080p, and custom;
  duration presets 6s, 10s, 15s, and custom. Unsupported values are disabled or
  rejected according to the model's policy, including custom values and locks.
- Aspect ratios use selection controls, not arbitrary text entry. Custom pixel
  dimensions use separate numeric controls and take precedence in the request.

Image resolution protocol review (2026-09-07): Gemini Generate Content uses
`imageConfig.imageSize`, Interactions uses `image_size`, and CPA Chat uses
`image_config.image_size` with native uppercase presets. xAI uses lowercase
`resolution` values (`1k`, `2k`) and disables the unsupported 4K shortcut. OpenAI Images
and Responses use pixel-valued `size`, subject to each model's size constraints.
Sources: [Gemini](https://ai.google.dev/gemini-api/docs/image-generation),
[xAI](https://docs.x.ai/developers/model-capabilities/images/generation),
[OpenAI](https://developers.openai.com/api/docs/guides/image-generation), and
[CPA translation](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/gemini/openai/chat-completions/gemini_openai_request.go).
This review and fixture coverage do not establish live Provider acceptance.

The Chat image adapter also supplies New API's `extra_body.google.image_config`
alongside CPA's top-level configuration, with identical values. It recognizes
New API's Markdown inline image data URLs in message content and assembled SSE
text chunks; ordinary text links are not downloaded. Existing image validation,
result-count bounds and filtered/incomplete response rejection still apply.

## Data behavior

Generation calls the real Job API. No browser timer or seeded production gallery simulates output. Mock remains a server test Provider; real generation requires an external Provider.

Unlabelled OpenAI-compatible and xAI image results use an unknown binary MIME hint until the existing media signature detector identifies the actual format. They are not assumed to be PNG. Explicit upstream MIME declarations remain subject to mismatch rejection. Output format is omitted unless selected by the user.

Compatible Images catalogs offer custom dimensions without inheriting GPT-only fixed-size restrictions. Model capability overrides can be saved from discovered models as manual definitions. The Composer exposes declared scalar extra parameters and omits aspect ratio when explicit dimensions take precedence.

Each Asset page contains at most 60 records and associated jobs. Search and project/favorite filters run on the server. There is no 1,000-result browsing cutoff or eager full-asset inventory request. Model selection distinguishes identical external model IDs belonging to different Providers. The Viewer uses original content URLs.

Each account remembers the image and video model independently within each project.
Generation parameters are restored per media type and Provider/model identity;
changing projects must not overwrite another project's selections. Account
management remains separate from generation preferences.

Write failures remain visible. Deletion requires confirmation and has no fictitious undo. Offline mode retains authenticated recent previews and prompt drafts and disables writes. API keys stay in the server's encrypted store; configuration exports exclude keys and custom headers.

## Verification

`e2e/workspace.spec.ts` exercises a real password-protected server across 1920, 1440, 1280, 1024, 834, 430, 390 and 360 pixel viewports. Baselines in `e2e/visual-baselines/workspace/` are project regression references, not a claim of Grok pixel parity. Tests cover generation, video, originals, favorites, failures, projects/search, masks, connections, persistence and WCAG 2 A/AA.

Run `pnpm run ci`, then `E2E_PORT=<unused-task-port> pnpm test:e2e --update-snapshots=none`. The single-container Docker API/archive/security smoke remains a separate gate. Default builds always ship this workspace.

Historical replacement acceptance (2026-09-05): 108 unit-test files / 996 tests, lint, TypeScript, production bundle budget, 56 browser tests across eight viewports, and the complete isolated Docker upgrade/archive/media/adapter/persistence smoke passed. These counts describe that milestone, not the current revision. Normal workflow tests block Service Workers so intercepted responses remain deterministic; a separate PWA suite enables and verifies the real offline cache on every viewport.

## Test media

Previously reviewed Unsplash photos now live only in `e2e/media/`; tests upload them through the Asset API. They are not production gallery content. PWA installation screenshots show this test session.

| File | Source |
| --- | --- |
| coast.webp | https://images.unsplash.com/photo-1518837695005-2083093ee35b |
| mountain.webp | https://images.unsplash.com/photo-1506905925346-21bda4d32df4 |
| botanical.webp | https://images.unsplash.com/photo-1497250681960-ef046c08a56e |
| architecture.webp | https://images.unsplash.com/photo-1486406146926-c627a92ad1ab |

Icons use existing Lucide; dialogs/popovers/tooltips use existing Radix. No dependency was added or upgraded.

## Connection and model administration

`/settings/providers` manages shared OpenAI, Gemini and xAI connections. One connection stores one endpoint and encrypted credentials for both image and video models. Existing individual protocol identifiers remain readable; editing a legacy connection upgrades it to its family while preserving existing model protocol bindings.

`/settings/models` provides search, connection/type filters, model creation, editing, copying, enable/disable and deletion of both manual and discovered models. Custom adapter models remain definition-managed. The model editor selects an explicit wire protocol, including a different family for compatible gateways, supported operations, reference-image limits and parameter rules. Rules define paths, scalar control types, choices, ranges, defaults, visibility, required values and locked defaults. Common configuration needs no JSON; advanced capabilities remain editable.

Connection settings do not expose the bulk model refresh command. Adding models
uses a read-only remote catalog and saves only the selected model. Loading model
capabilities queries server-side built-in presets for the selected model and
protocol, independently of the connection family. It fills missing capabilities
and parameter rules while preserving existing edits, and only Save writes them
to the database. Catalog lists alone do not establish upstream feature support.
The legacy refresh API remains available for internal/custom-adapter workflows;
its existing manual override protection is retained.

When parameter rules are enabled, the Composer renders only enabled, visible controls. Empty defaults are omitted from requests. The server independently applies the stored policy, rejects undeclared parameters and overrides client values for locked parameters before persisting the job. The selected model protocol is server-derived and snapshotted for asynchronous recovery. Native adapters still validate their actual wire contracts; configuring a parameter cannot make an upstream API support it.

xAI video catalog discovery tries the official dedicated path and falls back to `/models` only for HTTP 404, 405 or 501. Both catalog envelopes are supported. Connection tests expose fixed explanations for normalized HTTP statuses without returning upstream response bodies or credentials. Architecture reference and exact upstream review are recorded in `docs/third-party/reuse-audit.md`.
