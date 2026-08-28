# Hold

This file records non-blocking work that cannot currently be proven or completed without external evidence or a later phase. It must not contain secrets.

## Open

### Authenticated Grok Imagine reference package

- **Affects:** PR 1 final visual classification and PR 7 cross-device polish.
- **Status:** The private authenticated screenshot/video package is unavailable. Public unauthenticated evidence cannot prove strict L3/L4 parity for authenticated Gallery, Viewer, Saved, Collections, settings, task states, or mobile keyboard behavior.
- **Current handling:** Keep the implemented UI, eight-viewport PR 7 screenshots, and functional geometry/interaction evidence; do not claim strict L3/L4 or the visual policy's pixel threshold until the reference package is supplied and reviewed.

### PR 7 real-platform PWA and device evidence

- **Affects:** PR 7 cross-platform acceptance and PR 8 release evidence.
- **Status:** Ubuntu Chromium automation proves manifest/installability inputs, Service Worker control, install/update event handling, standalone layout semantics, offline recovery, and deterministic `visualViewport`/safe-area geometry. The available environment cannot prove completed installation on Windows Chromium, macOS Chromium, Android, or iOS Add to Home Screen, nor a real iOS/Android keyboard and device safe area.
- **Current handling:** Treat PR 7 implementation and automated acceptance as complete without claiming real-platform installation or device geometry. Capture OS-native installation, standalone relaunch, keyboard, and safe-area evidence on the named platforms before the v0.1.0 release claim.

### Live external Provider acceptance

- **Affects:** PR 4 real image Providers and PR 5 real video Providers.
- **Status:** No production API credentials or user-approved live endpoints are available in the repository or environment, and secrets must not be requested in source files or logs.
- **Current handling:** PR 4/PR 5 protocol fixtures, injected transports, deterministic Mock workflows, and the remote single-container smoke are accepted without live credentials. Record live credentialed smoke tests as pending unless a safe external test endpoint is explicitly provided.

### PR 8 provider-output cleanup reconciliation

- **Affects:** PR 8 media consistency and repair.
- **Status:** The first PR 8 media-consistency milestone now performs bounded audit reporting and startup reconciliation. A process crash can still leave provider-result files that are not represented by a durable cleanup queue, and durable repair remains a later milestone.
- **Current handling:** At startup, delete only deterministic provider provisional outputs for a known terminal Job when no Asset references any derived path. Preserve active, unknown, referenced, unsafe, or ambiguous entries. The authenticated media report flags managed-tree drift but never deletes orphan or referenced media.

### Dynamic model catalog pagination

- **Affects:** PR 4 live model refresh and future large Provider catalogs.
- **Status:** OpenAI, Gemini, and xAI refresh their live model catalog through the safe Provider transport, but the current refresh consumes one bounded response page. Providers with paginated catalogs larger than the first page require profile-specific pagination support.
- **Current handling:** Keep manual model creation available and add pagination when an official Provider fixture demonstrates a multi-page catalog.

### Static storage controls

- **Affects:** PR 8 maintenance settings.
- **Status:** PR 7 connected the update-notification preference to durable settings and the Service Worker update lifecycle. The Storage page's original-media and temporary-file retention controls remain presentational.
- **Current handling:** Connect retention and maintenance behavior with the PR 8 backup/media consistency work.

## Resolved

### PR 7 production bundle advisory

- **Affects:** PR 7 performance polish.
- **Historical context:** The production entry chunk was `571.55 kB` in the final PR 5 remote quality build, above Vite's 500 kB advisory threshold.
- **Resolution:** PR 7 route-split Settings, Library, and Mask editor and added a hard `500,000` raw-byte entry budget. Commit `a58ab7b` builds an entry of `334,651` bytes and passed [GitHub Actions run `33174754136`](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136).
- **Disposition:** The bundle advisory is closed; future regressions fail the production build.

### PR 7 update controls

- **Affects:** PR 7 PWA polish.
- **Historical context:** The update-notification control was initially a static Settings-shell element.
- **Resolution:** The preference is durable, update availability is exposed, applying an update flushes the Prompt draft before reload, and failures remain retryable. Unit and PR 7 browser gates cover these states.
- **Disposition:** The PWA update portion of the old static-settings hold is closed; only PR 8 storage retention remains open.

### PR 6 GitHub Actions incident evidence

- **Affects:** PR 6 remote verification evidence.
- **Historical context:** [GitHub incident `y1t7p9fzrlj2`](https://www.githubstatus.com/incidents/y1t7p9fzrlj2) and [GitHub incident `kfspvrz14xr0`](https://www.githubstatus.com/incidents/kfspvrz14xr0) previously prevented the expected PR 6 run from being generated.
- **Resolution:** Commit `79a30f2` passed [GitHub Actions run `33140963119`](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119). Its Quality, single-container smoke, and Playwright jobs all concluded successfully; detailed job evidence is recorded in [`docs/architecture/pr6-verification.md`](./docs/architecture/pr6-verification.md).
- **Disposition:** The outage-related PR 6 hold and its run placeholders are closed.

- Default Provider HTTP remains HTTPS-only unless the dedicated, explicit `ALLOW_INSECURE_PROVIDER_HTTP` switch is enabled.
- Provider stage retry budgets are durable across SQLite close/reopen recovery.
