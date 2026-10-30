# Hold

This file records known limitations and pending external evidence. Historical PR numbers identify the origin of an item, not the current development phase. Dated verification below applies only to its recorded revision; it is not acceptance of the current checkout. Code review findings are indexed in [docs/README.md](./docs/README.md#dated-reviews). It must not contain secrets.

## Open

### Authenticated Grok Imagine reference package

- **Affects:** Authenticated visual-reference parity and cross-device polish.
- **Status:** The private authenticated screenshot/video package is unavailable. Public unauthenticated evidence cannot prove strict L3/L4 parity for authenticated Gallery, Viewer, Saved, Collections, settings, task states, or mobile keyboard behavior.
- **Current handling:** Keep the implemented UI, eight-viewport PR 7 screenshots, and functional geometry/interaction evidence; do not claim strict L3/L4 or the visual policy's pixel threshold until the reference package is supplied and reviewed.

### Real-platform PWA and device evidence

- **Affects:** Physical-device PWA and release acceptance claims.
- **Status:** Ubuntu Chromium automation proves manifest/installability inputs, Service Worker control, install/update event handling, standalone layout semantics, offline recovery, and deterministic `visualViewport`/safe-area geometry. The available environment cannot prove completed installation on Windows Chromium, macOS Chromium, Android, or iOS Add to Home Screen, nor a real iOS/Android keyboard and device safe area.
- **Current handling:** The historical PR 7 automated acceptance and v0.1.0 release did not prove physical-device installation or geometry. Capture OS-native installation, standalone relaunch, keyboard, and safe-area evidence before making platform-complete claims; rerun automated acceptance for the revision being released.

### Live external Provider acceptance

- **Affects:** Credentialed image/video generation against a specific Provider, endpoint and model.
- **Status:** Repository fixtures and Mock tests do not establish live acceptance. Credential availability and authorization are deployment/session-specific; this document does not inventory the current environment. Never place credentials in source files or logs.
- **Current handling:** Report protocol fixtures, injected transports and Mock/container checks separately from live tests. Live generation requires an explicitly authorized endpoint and scope; record its date, model, operation and result without secrets. Catalog or connection success alone is not generation acceptance.

### Provider-output cleanup reconciliation

- **Affects:** Media consistency and repair.
- **Status:** The implementation has bounded audit reporting, startup reconciliation, a durable repair queue, authenticated scan/queue report endpoints, and a fixed-batch one-shot action for safe missing derived media. A process crash can still leave provider-result files that are not represented by a durable cleanup action, and primary/orphan/unsafe media still require manual handling.
- **Current handling:** At startup, delete only deterministic provider provisional outputs for a known terminal Job when no Asset references any derived path. Preserve active, unknown, referenced, unsafe, or ambiguous entries. Reconcile persists safe issue records; the repair action only regenerates a missing thumbnail/poster after strict Asset/path/primary validation, never deletes managed-tree orphans, and never runs as a resident worker.

### Dynamic model catalog pagination

- **Affects:** Live model refresh for paginated Provider catalogs.
- **Status:** OpenAI, Gemini, and xAI refresh their live model catalog through the safe Provider transport, but the current refresh consumes one bounded response page. Providers with paginated catalogs larger than the first page require profile-specific pagination support.
- **Current handling:** Keep manual model creation available and add pagination when an official Provider fixture demonstrates a multi-page catalog.

### Media retention policy

- **Affects:** Storage lifecycle and maintenance settings.
- **Status:** Ordinary asset deletion is a soft delete: it hides the asset and blocks media delivery but retains its managed files. General original-media/temporary-file retention policies are not implemented, and the current Data page does not expose those former presentational controls. It provides real integrity checks, database-only backup, media audit and missing-preview repair. Temporary video-frame cleanup is a separate bounded mechanism, not a configurable retention policy.
- **Current handling:** Do not advertise automatic storage retention or orphan deletion. Add configurable retention only as a separately specified change with ownership, reference and recovery checks.

### Offline restore same-UID replacement window

- **Affects:** Offline restore publication and cleanup.
- **Status:** The restore records and rechecks canonical parent and reservation device/inode identities, and preserves a replacement detected at a check point. Node's promise filesystem API does not provide an atomic `renameat2`-style no-replace directory operation.
- **Current handling:** Restore requires an absent target and uses an empty 0700 reservation before renaming. A same-UID process can still replace that reservation between the final identity check and `rename`; this narrow TOCTOU window is outside the current atomicity guarantee and must not be described as fully race-proof.

## Resolved

### PR 8 runtime gate removal

The former same-UID gate replacement window no longer applies: the runtime/offline file-lock implementation was removed at the maintainer’s request. Offline archive operations remain an operator-managed stopped-service procedure.

### PR 7 production bundle advisory

- **Affects:** PR 7 performance polish.
- **Historical context:** The production entry chunk was `571.55 kB` in the final PR 5 remote quality build, above Vite's 500 kB advisory threshold.
- **Resolution:** PR 7 route-split Settings, Library, and Mask editor and added a hard `500,000` raw-byte entry budget. Commit `a58ab7b` builds an entry of `334,651` bytes and passed [GitHub Actions run `33174754136`](https://github.com/YuSaZh/Imagine./actions/runs/33174754136).
- **Disposition:** The bundle advisory is closed; future regressions fail the production build.

### PR 7 update controls

- **Affects:** PR 7 PWA polish.
- **Historical context:** The update-notification control was initially a static Settings-shell element.
- **Resolution:** The preference is durable, update availability is exposed, applying an update flushes the Prompt draft before reload, and failures remain retryable. Unit and PR 7 browser gates cover these states.
- **Disposition:** The PWA update portion of the old static-settings hold is closed; the separate media retention policy remains open.

### PR 6 GitHub Actions incident evidence

- **Affects:** PR 6 remote verification evidence.
- **Historical context:** [GitHub incident `y1t7p9fzrlj2`](https://www.githubstatus.com/incidents/y1t7p9fzrlj2) and [GitHub incident `kfspvrz14xr0`](https://www.githubstatus.com/incidents/kfspvrz14xr0) previously prevented the expected PR 6 run from being generated.
- **Resolution:** Commit `79a30f2` passed [GitHub Actions run `33140963119`](https://github.com/YuSaZh/Imagine./actions/runs/33140963119). Its Quality, single-container smoke, and Playwright jobs all concluded successfully; detailed job evidence is recorded in [`docs/architecture/pr6-verification.md`](./docs/architecture/pr6-verification.md).
- **Disposition:** The outage-related PR 6 hold and its run placeholders are closed.

## Current operational boundaries

- Provider HTTP and HTTP media downloads follow the administrator-owned, persisted `network.allow_http_content` preference, enabled by default. Either legacy HTTP environment flag set to false initializes it as disabled only when no stored value exists. Private-network access remains a separate opt-in. See [current architecture](./docs/architecture/overview.md#provider-and-job-boundaries).
- Stop the application before offline archive creation or restore. There is no shared runtime/CLI file lock that enforces this procedure; archive verification is read-only. See [deployment and backup guidance](./RELEASE.md#backup-and-verification).
