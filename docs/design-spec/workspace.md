# Imagine workspace

The production UI in `apps/web/src/features/workspace/` replaces the previous page components, page store, styles, visual fixtures and separate interaction prototype. All routes use one authenticated application and real internal APIs. Existing `/interaction.html` bookmarks redirect to `/imagine`.

This is the current UI specification. Contributor workflow and scoped rules live
in [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[apps/web/AGENTS.md](../../apps/web/AGENTS.md).

## Interaction

- `/imagine`: bottom Composer on desktop and phones, with a virtual masonry gallery above. Models, input modes, aspect ratios and parameters follow enabled Provider capabilities; compatible image models also expose custom pixel dimensions and declared extra fields such as quality and output format.
- `/library`, `/saved`, `/projects/:id`: server-filtered assets, filename/prompt/model search, pagination, selection, favorites, project membership and confirmed deletion.
- Completed-job placeholders only bridge the delay before generated assets appear. Once a result has appeared, deleting or filtering it must not recreate a completed placeholder. Partial batch deletion refreshes successful removals and keeps failed items selected for retry; deleting assets preserves task history.
- `?asset=:id`: original image or native video, original MIME download, zoom/gestures, request information and continued creation.
- `/edit/:id`: responsive original-image mask canvas, brush/eraser, undo/redo and persisted source/mask inputs.
- `/jobs`: durable status, results, cancellation and retry; also available from the header.
- `/settings`: persisted preferences, Provider/model management, custom HTTP/trusted JavaScript adapters, database/media maintenance and PWA controls.

Project actions include a persisted privacy toggle, off by default for existing
and new projects. Private project members are excluded from the home recent feed and All Works
before pagination and search; tasks submitted inside a private project are also
excluded from home placeholders. Membership in any private project takes priority
over simultaneous public membership. Turning privacy off restores recent visibility.
Project tiles use a blurred abstract cover with a privacy indicator and do not
load private thumbnails. Opening the project still shows its contents normally;
favorites and task history remain available. This is a presentation
setting within the owning account, not a separate access password. Offline recent
views hide project items unless cached project settings establish public visibility.

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
  The entire capsule is one toggle button: clicking either half, the selected
  label or the padding switches mode. Enter and Space operate the same control.
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
  The explicit `imageResolution` capability declares native or pixel mode,
  allowed values, custom-dimension permission and optional dimension constraints.
  It drives selection, hydration and validation independently of model ID.
  Server catalog templates supply known-model defaults; explicit capabilities
  override them. Legacy capability lists and parameter options retain their
  declared values, including strict pixel enumerations on native protocols.
  Such pixel choices still need a ratio before conversion; directly permitted
  native tiers never require that step. Unknown capabilities do not grant
  undeclared tiers. Native auto ratio stays omitted on the wire.
  Pixel-only models map presets by aspect ratio. For 16:9, presets
  map to 1280x720, 2048x1152, and 3840x2160; portrait swaps the dimensions.
  Other ratios use 1024, 2048, and 3840 as the longest edge. Derived edges round
  to the nearest multiple of 16, including 3:2 and 2:3. Auto never implies 1:1:
  native tiers can be sent without an aspect ratio; pixel-only tiers require an
  explicit ratio. With auto selected, clicking a pixel tier opens a ratio card
  inside the resolution popover; selecting a supported ratio applies both values
  atomically. Unsupported model/ratio combinations are excluded. GPT Image 2
  shares its dimension validation between frontend and server, including the
  8,294,400 total-pixel limit, so its 4K preset supports 16:9 and 9:16 only among
  the standard ratios. Selecting auto in the ratio menu clears an editable pixel
  resolution to auto, while native tiers remain selected. Custom dimensions can
  still be explicitly applied with auto ratio. Chat adapters map
  recognized pixel sizes to upstream aspect-ratio/size fields and reject
  unrepresentable custom sizes; Images adapters retain pixel sizes. Actual
  output dimensions remain subject to the upstream model. Model rules, locks and
  custom-size limits apply; shortcuts share the saved generation settings.
- Mobile image generation settings offer `auto`, `1K`, `2K`, `4K`, and
  custom dimensions, plus additional explicitly configured native values,
  using the same preset mapping as desktop. This applies to
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
  to the nearest configured multiple (16 by default) on blur/apply (ties round upward);
  the derived edge is also rounded, so the ratio may differ by rounding error.
  Both edges remain at most 16384, with at most 100 million pixels total.
  Applying custom dimensions preserves the selected aspect ratio rather than
  replacing it with a reduced width/height fraction. Native preset wire values
  and model-specific custom-size restrictions remain in effect.
- Model editing exposes resolution mode, allowed values and dimension limits.
  Both UI and server enforce the same capability plus stored parameter rules.
  The server discards client-provided `imageResolutionPolicy` and snapshots its
  own effective capability into each job; retry/recovery retain that snapshot.
  Provider requests omit the internal snapshot and receive it through server
  context. New native values can pass through supported adapters without adding
  model-ID checks; this does not establish upstream support for those values.
- Desktop video shortcuts offer resolution presets 480p, 720p, 1080p, and custom;
  duration presets 6s, 10s, 15s, and custom. Unsupported values are disabled or
  rejected according to the model's policy, including custom values and locks.
- Aspect ratios use selection controls, not arbitrary text entry. Custom pixel
  dimensions use separate numeric controls and take precedence in the request.

Video workflows include editing, extension and supported first/last-frame inputs.
Modes derive from stored capabilities, and per-operation policies govern controls,
input types and validation. Source videos are selected from the library or uploaded
where the operation permits; results are independent assets linked to the source.
Changing modes invalidates incompatible inputs. Private remote provenance is
resolved on the server, and snapshots preserve submitted limits across recovery.
See the maintained [model capability table](../model-capabilities.md) for coverage.

Media cards with a prompt offer a bottom-right copy control. Desktop retains
30px frosted circular buttons with 9px edge offsets. Mobile card actions use
20px translucent white icons (78% opacity) with a light dark icon shadow, no background blur or resting
fill, and 5px horizontal / 8px vertical visible edge offsets. Transparent 40px targets do not overlap;
pressed feedback and filled saved icons remain available.
It appears on hover/focus on desktop and remains visible on mobile. Selection
mode hides it; uploaded assets without prompts omit it. Copy uses the full prompt,
preserves card/viewer state and reports success or failure through the shared notice.
Selected cards draw their green/white ring inside the card, preserving gallery
geometry and avoiding clipping at scroll container edges.

Focusing the mobile prompt does not change textarea or Composer height. Keyboard
avoidance still follows the visual viewport without expanding the input.
On both layouts, generation settings use aligned pale value fields with matching
height, padding and typography. Selectable values include a right chevron; numeric
and text inputs share the surface style. Ratio, resolution and count retain their
existing popover contents. Rows have consistent separators, including managed
resolution controls.

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
Automatic choices survive internal request validation until server model defaults
and locks have been applied, then are omitted from Provider requests. Model size
and total-pixel limits remain enforced even when a preset exceeds those limits.
Deriving new parameter rules from capabilities preserves an unconstrained string
`customFields.properties.size` as flexible resolution input. Enumerated/constant
size fields stay restricted; reloading capabilities preserves existing edited rules.

The Chat image adapter also supplies New API's `extra_body.google.image_config`
alongside CPA's top-level configuration, with identical values. It recognizes
New API's Markdown inline image data URLs in message content and assembled SSE
text chunks; ordinary text links are not downloaded. Existing image validation,
result-count bounds and filtered/incomplete response rejection still apply.
Chat image requests embed source/reference image bytes as Base64 data URLs even
when public input links are enabled. CPA's Gemini Chat translator parses inline
data but skips ordinary HTTP image URLs; sending a public link can therefore
silently turn a reference-based request into text-only generation. Other
protocols retain their existing public-link handling. Input roles, ordering,
ownership, integrity and byte limits remain enforced before encoding.

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
uses a model editor whose generation parameters start collapsed on each opening.
Expanding or collapsing preserves unsaved values; loading capabilities does not
force it open, and load errors remain visible. The editor body scrolls without
visible scrollbar tracks on desktop and mobile, while Save and Cancel stay fixed
below the scrollable content.
Adding models
uses a read-only remote catalog and saves only the selected model. Loading model
capabilities queries server-side built-in presets for the selected model and
protocol, independently of the connection family. It fills missing capabilities
and parameter rules while preserving existing edits, and only Save writes them
to the database. Catalog lists alone do not establish upstream feature support.
The legacy refresh API remains available for internal/custom-adapter workflows;
its existing manual override protection is retained.

Adding a recognized model from the remote catalog loads its full built-in
capabilities. Recognized entries are highlighted and stably partitioned ahead of
unknown entries in this picker, including filtered searches. Recognition and
template selection share the server library; vendor-name guesses are insufficient.
Loading fills the complete
capabilities and derives editable parameter rules before save. Loading is read-only;
it does not create or modify a stored model until the user saves. Switching models,
copying a configuration or editing capabilities invalidates pending automatic
loads. Unknown models keep an editable initial configuration without invented
capabilities. The model editor also offers built-in templates across protocols and
saved model configurations as explicit copy sources. Copying retains the target
ID, display name, enabled state and connection; saved parameter rules, defaults and
locks are preserved. Source credentials and connection settings are never copied.

When parameter rules are enabled, the Composer renders only enabled, visible controls. Empty defaults are omitted from requests. The server independently applies the stored policy, rejects undeclared parameters and overrides client values for locked parameters before persisting the job. The selected model protocol is server-derived and snapshotted for asynchronous recovery. Native adapters still validate their actual wire contracts; configuring a parameter cannot make an upstream API support it.

xAI video catalog discovery tries the official dedicated path and falls back to `/models` only for HTTP 404, 405 or 501. Both catalog envelopes are supported. Connection tests expose fixed explanations for normalized HTTP statuses without returning upstream response bodies or credentials. Architecture reference and exact upstream review are recorded in `docs/third-party/reuse-audit.md`.

## Sign-in screen

Initial session validation runs without a dedicated access-check page, brand or
spinner. The workspace mounts only after authentication succeeds; failures and
expired sessions retain visible retry/login handling.

The login page uses a compact branded card with Username and Password fields
and a Login button. It omits the protected-workspace caption and decorative
password/button icons; submission progress and authentication errors remain visible.
Inputs retain autocomplete and do not automatically open the mobile keyboard.

### Gallery return-to-top and account login

- Recent creations, all works, favorites and project-detail galleries show a return-to-top button after the active scroll container exceeds 600px. Desktop uses the internal gallery scroller; mobile uses the workspace scroller.
- The button aligns horizontally with the Composer send button's center, 12px above the Composer. Pages without a Composer retain alignment to the gallery's right edge and a 20px viewport-bottom gap. It is 40px on desktop and 44px on mobile, with a light circular surface, fine border and subtle shadow, without backdrop blur. It hides in selection mode, the viewer/editor and while the soft keyboard reduces the visible viewport.
- Clicking scrolls to the top smoothly, unless the application/system reduced-motion setting requests immediate movement. Route changes, layout changes and Composer resizing recompute placement.
- Login initializes the username and password as empty, including after logout/session expiry. Either empty field disables submission. Standard `username` and `current-password` autocomplete attributes remain available to the browser; the application does not assume an account name.

### In-place media editing workspace

Opening an image or video shows its original content and a compact floating Composer, replacing the old action footer and zoom widget. Focusing expands the existing Composer; clicking the image stage collapses it without clearing text or settings. Settings popovers and uploads do not collapse it. Desktop wheel zoom is anchored to the pointer, clamped to 1–4×, with drag and double-click reset; mobile pinch/double-tap remains available.

The editor binds the current source implicitly. Image mode prefers `image.edit`, or an explicitly declared reference-image generation operation. Video mode uses the clean original as a single first frame, temporarily hiding the mask. Task creation remains in the viewer, with progress, explicit retry/cancel actions and output thumbnails above the Composer. Clicking an image result starts a new source draft; videos play inline. Closing the viewer never cancels submitted jobs. Drafts are isolated by account/workspace mount, project and source, with eight recent in-memory source sessions retained. Model settings use a separate editing memory scope, retaining the same per-mode/per-model structure without overwriting the main Composer draft.

The mask button is hidden while the prompt is unfocused, including when the viewer is idle or settings are open. Focusing the prompt reveals it; activating it preserves focus long enough for mouse/touch clicks, and keyboard focus on the entry remains supported. On desktop and mobile single works, the mask button sits 12px above the Composer; mobile series place it 12px above the thumbnail strip. It remains horizontally centered on the send button, matching the return-to-top circle size (40px desktop, 44px mobile). Applying a mask returns to the same image, displaying its tinted coverage. Reopening preserves the applied document, including undo history; clearing and applying removes coverage. Dirty-state confirmation compares coverage with the last applied document. Brush, eraser, diameter, undo/redo, clear and visibility controls sit below the canvas, respecting bottom safe areas.

Mobile generation settings value fields use the same 12px font as row labels, overriding only the Composer settings panel's enlarged controls. Desktop typography and option-card styling are unchanged.

Video sources use the same floating Composer and inline task/results UI. Video mode offers declared editing/extension operations and sends the original video. Switching to image mode leaves the video visible and seekable and performs no capture or upload. Only opening the mask editor or pressing send pauses and captures the decoded current frame with Canvas, retaining native dimensions. A mask freezes its source frame; unmasked sends always use the video's current position. Switching modes alone never creates an asset. Capture/upload errors preserve the video and show a retryable error without submitting a job.

Captured frames and their masks are server-marked temporary inputs, excluded from gallery, library, project covers and item counts immediately. They retain ownership checks and source provenance. The server removes their media/thumbnail files after all jobs referencing the frame/mask group reach a terminal state, including failures and cancellation; cleanup runs independently of the browser and resumes after restart. Unsubmitted abandoned inputs expire after 24 hours. Tombstone records preserve job history, while generated outputs link to the original video. Retrying after cleanup requires an explicit fresh send at the selected video position; the application does not silently regenerate an input or reuse a missing mask. No additional player or browser decoder dependency is introduced.

Model-adding catalogs exclude saved model IDs in the current provider, including disabled models; deletion makes the remote entry available again through the shared catalog query. Other providers do not affect these choices. Shared Select popovers use a modal scroll/focus scope, allowing wheel and touch scrolling inside nested model dialogs while keeping the underlying form stationary.

Generation placeholders use “生成中” once a task is submitting or processing, and display elapsed whole seconds from its persisted creation timestamp, refreshing every second. Queued tasks retain “等待生成”. Completed media captions append elapsed creation-to-completion time after the model ID (`gpt-image-2 · 48s`, `1m10s`); uploads or missing timestamps have no fabricated duration. Timers stop when active cards unmount or tasks finish.

The main prompt grows with its wrapped content from two lines to at most five desktop lines or four mobile lines. Mobile blur collapses it to two lines and focus restores the required height; desktop blur retains height. Beyond the cap the prompt scrolls internally. Width changes, pasted text and restored drafts use the same measurement. The viewer’s compact entry retains its existing pill layout until expanded.

Clicking the desktop rail logo expands the existing rail from 72px to 260px in the normal flex layout. The logo and navigation icons keep their positions; text labels and a separate project section appear to their right/below. The gallery and Composer use the remaining width. No dialog, backdrop, blur or focus trap is introduced. Navigation keeps the rail expanded; the same logo toggles it closed, and Escape inside the rail also collapses it. The header wordmark retains its home action. Mobile navigation keeps its existing drawer.

### Project moves and deletion

Image and video card menus use a 190px minimum width and offer “移动到项目”. The project picker lists the account's projects, marks existing membership, and disables the sole current destination. A move replaces all previous memberships atomically; unlike batch “加入项目”, it does not leave the media in the source project. Project counts and privacy filtering refresh from authoritative data. Offline writes are unavailable.

Deleting a project presents an unchecked “同时删除项目内文件” checkbox. The default removes only the project and preserves media. Opting in soft-deletes all current member assets, including their memberships elsewhere, through the existing asset deletion path; managed file cleanup continues to respect reference retention. Membership deletion, asset changes and outbox events commit atomically. Both operations enforce account ownership; failed validation leaves memberships and assets unchanged.

### Editing series

Submitting from an editor selects a large animated generation state in the main stage, with elapsed time. Active generation omits prompt text, cancellation and copy controls from the stage; task management retains cancellation. Failed states retain failure feedback, retry and prompt copying. The source becomes the first thumbnail above the Composer, followed by derived images/videos and pending or failed jobs. Successful output is selected automatically unless the user has switched to another item. Pending/failed job views require selecting an existing image or video before another edit submission. Clicking any thumbnail switches the stage and editing source; image/video playback and per-source drafts remain isolated. Desktop arrows and Left/Right keys traverse the series, then continue into the adjacent gallery entry at a series boundary; single works also support adjacent navigation. Mobile horizontal swipes stay within the series, while vertical single-finger swipes at 1x switch gallery entries. Zoom/pinch and native video controls retain their behavior.

Series are reconstructed server-side from the primary source/first-frame/first-reference input and job outputs, with account isolation. Additional references and masks do not merge series. Temporary video-frame records bridge to their parent video even after soft deletion but never appear as thumbnails. Reloading any member recovers the series; traversal is bounded to 1000 nodes with an explicit partial-series notice for larger graphs. Deleted content is omitted. Failed gallery cards also expose a prompt-copy button.

### Series display preferences

Preferences offer an account-persisted “按照系列显示” switch, off by default.
Its nested “并发生图作为系列显示” switch also defaults off and retains its saved
value when the parent switch is disabled. With both enabled, images from one
concurrent submission and their edits share a gallery entry and editor strip.
The server records image batches regardless of the display setting; toggling it
regroups existing recorded batches. Independent submissions and video-only batches
remain separate. Historical jobs without a recorded batch retain existing grouping.
Batch links survive retries and restart, and all existing cover/filter/privacy and
pagination rules apply. The asset-list and series-detail APIs accept the optional
`groupConcurrentImages=true` query flag; gallery grouping still requires
`groupBySeries=true`. Browser query keys include the effective grouping choice.
When enabled, recent creations, All Works, favorites and project galleries merge
each editing series into one entry with a bottom-left member-count badge and stacked-image icon, leaving the top-left video duration unobstructed. Hover captions reserve room above the badge. Grouping
runs on the server before cursor pagination. The latest matching member anchors
series ordering and cursors, independently of the selected cover. Search, media
type, favorite, project and privacy filters apply to covers and counts; hidden
members never become covers. Selection mode expands individual works, so bulk
operations retain their existing per-asset meaning. Card actions affect the cover
asset; opening it restores the existing editor series strip.

The nested cover preference offers latest generated work (default), most recently
viewed work, or original work. Deleted/filtered originals fall back to the oldest
visible member; absent recent history falls back to the newest visible member.
Recent views are persisted per account and project, retaining 500 asset timestamps
per context. Viewing a member in the editor updates its timestamp; changing the
cover preference does not erase history. Temporary captured frames bridge lineage
but are never gallery entries. Offline mode retains the available cached previews
without attempting new grouping or writes.

### Editor navigation and immediate recent covers

Only multiple visible members or unresolved editing jobs show the thumbnail strip;
a single completed generation is not presented as a series. Selected thumbnails
use an inset overlay ring contained within the scrolling strip. The return button
retains its accessible name and keyboard focus but has no tooltip on entry.

Each selected member immediately updates the account/project-scoped recent-view
record and compatible cached gallery covers; every switch saves independently.
Only after saving succeeds does the gallery refetch the authoritative cover.
Filtering, private project visibility and per-entry counts remain respected.
Series responses seed member caches so moving among already loaded members keeps
the editing layout populated. When moving beyond loaded gallery entries, fetch the
next page before navigating. Gallery ends stop navigation rather than wrapping to
an unrelated loaded subset. Mobile vertical entry navigation opens the chosen cover;
desktop boundary navigation opens its first/last member according to direction.

On a cold media-type filter switch, retain the current gallery while the next
filtered response loads, indicating busy state without a blank loading replacement.
This placeholder reuse applies only within the same query scope; project, privacy,
search, favorites and grouping changes must not carry stale content across scopes.

### Floating mobile editor and media transitions

On mobile, the editor has no full-width heading bar: a 44px circular return button
floats at the upper left and a rounded three-action toolbar floats at the upper
right, respecting the top safe area. The filename remains the accessible dialog
title but is visually hidden on mobile. Desktop heading layout is unchanged.
Mobile series thumbnails are 59x53px (roughly two thirds of desktop's 88x80px),
with touch targets above 44px. When a series strip exists, the focused mask button
floats 12px above the strip, aligned with Send; without a series it stays above
the Composer. Desktop thumbnail size and mask-button placement are unchanged.

Unzoomed drags move the media with the pointer. Horizontal member navigation and
desktop arrows/keys slide the old media out and the next media in; mobile vertical
entry navigation uses the same effect on the vertical axis. Snap-back handles
cancelled or unavailable movement. A temporary visual copy contains only the
outgoing media (a captured canvas for decoded video), while controls stay stable
and interactive above it. Loading retains the old visual until the next image or
poster decodes. The copy and animations are cleaned up after completion,
interruption, failure or closing. Reduced-motion preferences skip these effects.
Each actual selection still saves recent-view history immediately, independently
of animation completion.

The editor's missing-model guidance appears only while the prompt is focused and
hides on blur, including in compact mode. Main-page model guidance, offline status,
and real save/upload/capture/submission errors retain their existing behavior.

### Adjacent media during a held drag

The current media and its adjacent media move together while the pointer remains
down. The editor prepares at most four neighboring thumbnails/posters (previous
and next on the supported axes), without selecting them or loading full videos.
Dragging reveals the adjacent visual continuously; reversing direction replaces
the revealed neighbor. On release, the displayed pair completes only its remaining
distance. The incoming visual is retained through the source-session remount and
aligned with the final media layout before being replaced by the decoded original.
A cancelled drag returns both visuals to their starting positions and does not
write a recent-view record. Only committed selection updates history. Existing
mobile horizontal-series/vertical-entry boundaries and desktop navigation remain.

Opening a gallery entry uses that exact entry's metadata for the editor's first
frame while detail requests run. Detail and job data must match the selected IDs;
a previously closed viewer item is never reused as an unrelated entry's loading
placeholder. Neighbor previews remain confined to intentional drag navigation.

### HTTP content preference

Administrators see “是否允许 HTTP 内容” in Settings → Preferences. The single instance-wide checkbox controls both Provider HTTP requests and HTTP media downloads, defaults to enabled, saves immediately, and persists across reloads and server restarts. Helper text explains that HTTP is unencrypted. Loading, offline and pending states disable the control; read/write failures remain visible. Non-admin users cannot edit this setting. Existing explicit false HTTP environment flags initialize it as disabled; the stored preference takes precedence afterward.

### Mobile editor edge back

The mobile editor hides previous/next buttons; members remain accessible through horizontal swipes and the series thumbnails. Desktop previous/next buttons remain visible.

At viewport widths up to 760px, a single touch starting in the screen's leftmost 24px of the main editor's media stage reserves a back gesture. A rightward release of at least 72px, with horizontal distance greater than 1.5 times the vertical distance, closes the editor through its normal close action. A small noninteractive back indicator fades in as the gesture progresses; this gesture does not select or preview a neighboring work. Short/reversed/vertical gestures, pointer cancellation and lost capture do not close it. At zoom levels above 1x, dragging continues to pan; adding a second finger switches to pinch and cannot close the editor. Desktop input, gestures outside the edge strip, native video controls, forms and the separate mask editor keep their existing behavior. Closing retains source drafts and does not cancel submitted jobs.

### Persistent editor settings and live preferences

Workspace and per-source editor memory retain their existing account/project/mode/model separation. UUID project and asset IDs are supported together; settings keys allow 128 characters without changing existing key names or stored JSON. Switching models and reloading restores each model's parameters independently. Settings changed in another page of the same account refresh through SSE; global settings reach all signed-in accounts, and private preference keys are not exposed to other accounts. Remote invalidations wait for local optimistic writes to settle. Recent-series history changes also invalidate the affected gallery query family.

### Editor preload and floating details

The homepage has priority over speculative editing downloads. Visible gallery
images load eagerly at high priority; offscreen previews remain lazy at low
priority. Historical SSE event bursts coalesce query-family refreshes in 100ms windows;
in-flight requests are reused, with one trailing refresh for changes received
during the fetch. This avoids cancelled-request storms while retaining live
updates and local optimistic settings writes. Once the gallery, settings and catalog/job requests settle and visible
images have loaded and decoded, editing modules preload one at a time on idle
turns after a 500ms quiet period. Scrolling or typing resets that period; route
changes, active data requests, hidden tabs and offline state defer pending work.
Browsers without idle callbacks use the quiet period followed by a frame callback.
Opening a work explicitly still loads its editor immediately. A warmed module renders synchronously on its
first opening without a temporary loading dialog; early opens or slow/failed
loads retain genuine loading/error handling. This does not fetch all originals
or perform Provider calls.

Desktop work details float below the information button in a 420px card with a
border, rounded corners and subtle shadow. Opening it never resizes or shifts
the image stage. Both layouts hide the details scrollbar and keep the title and
close button outside the scrolling body. Mobile details use 16px top padding, grow
naturally with prompt content and preserve line breaks. They scroll only after reaching their 70dvh
height cap (further limited by the floating toolbar, Composer, keyboard and safe
areas). A visible series strip also reserves space below the details card. Both layouts bound long content within the viewport. Escape closes the
details first, then the viewer on the next press.

When the complete details would exceed their available height, the card uses its
maximum allowed height immediately. After reserving space for the fixed header,
metadata and actions, the prompt shows as many complete lines as fit, with an
ellipsis and an “展开全部” button for the remainder. The line count is measured
from the current font, width and available height. Shorter/fitting prompts stay
complete in a naturally sized card. Expansion and “收起” keep the same card size
and position; only the body content and scrolling change. If metadata alone
exceeds the available space, retain one prompt line and allow the body to scroll.
Changing the viewport remeasures available space, and opening another work resets
manual expansion. “生成时间” appears immediately before “创建时间” and uses the
persisted job creation-to-completion duration; uploads or missing timestamps show
“—”. Tapping outside mobile details dismisses them, while the information toggle
and the details project picker preserve their normal interactions.
